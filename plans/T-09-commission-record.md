# Plan

## Overview

Two AD-001 invariant violations coexist in the codebase. (1) processPaymentCapture in src/features/payments/webhooks/handlers.ts upserts LabWallet.pendingBalance by Transaction.amount at payment capture — that write was authored under the prior aggregator assumption (PipetGo as escrow). Under AD-001 Direct Payment, the lab already receives the full amount via Xendit Managed Sub-Account split at the moment of payment; LabWallet is repurposed as PipetGo's commission ledger per lab, not lab escrow. The handler writes the wrong number into the wrong column. (2) completeOrder in src/features/orders/lab-fulfillment/action.ts transitions IN_PROGRESS to COMPLETED with no Payout record recording PipetGo's confirmed commission for the order. The Payout schema model already exists (grossAmount/platformFee/netAmount/feePercentage/status=QUEUED) but no slice writes to it. Without a Payout record at completion, T-10 (commission settlement webhook) has nothing to mark COMPLETED, and T-11 (lab wallet dashboard) has no commission history to render. Both failure modes are documented in docs/roadmap.md AD-001 as known inconsistencies scoped to T-09.

**Approach**: Three coordinated edits with no schema migration. (1) Delete the LabWallet upsert block and the unused order.findUnique inside processPaymentCapture in src/features/payments/webhooks/handlers.ts; the handler retains its Transaction.update plus handlePaymentCaptured dispatch and nothing else, matching the AD-001 invariant that webhook capture is a status-only operation. (2) Add src/domain/payments/commission.ts exporting COMMISSION_RATE as a Decimal placeholder of 0.10 with a TODO comment for the rate-source decision; the file imports Decimal from @prisma/client/runtime/library matching the existing src/domain/payments/events.ts and src/domain/orders/pricing.ts pattern. (3) Extend completeOrder in src/features/orders/lab-fulfillment/action.ts to look up the CAPTURED Transaction for the order inside the same prisma.$transaction as the Order COMPLETED update, compute platformFee = grossAmount * COMMISSION_RATE and netAmount = grossAmount - platformFee with Decimal arithmetic, and tx.payout.create with status=QUEUED. Throws if no CAPTURED Transaction exists (Implementation Discipline). (4) Rewrite the first three handlers.test.ts tests so they assert LabWallet remains null after capture and the Transaction is CAPTURED; add a fourth-block test that exercises completeOrder end-to-end and asserts Payout fields. The webhook rollback test (handlers-rollback.test.ts) drops its labWallet.upsert mock and order.findUnique mock since neither call occurs in handlers.ts.

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Remove LabWallet.pendingBalance upsert from processPaymentCapture entirely (not relocate, not feature-flag) | Under AD-001 Direct Payment (docs/roadmap.md AD-001), Xendit Managed Sub-Accounts split commission to PipetGo at settlement, so the lab already holds the full amount at capture -> any pendingBalance write at capture corrupts the AD-001 semantics where LabWallet tracks PipetGo's commission income, not lab escrow -> the correct write is a Payout record at order completion (when commission is confirmed), not a wallet credit at capture. Relocating the upsert to a later phase is rejected because the wallet balance move belongs to T-10 (settlement webhook), not T-09. Feature-flagging is rejected because AD-001 is the resolved decision (not an experiment) and a stale flag would carry the wrong-semantics write in dev environments. Deletion is the AD-001-compliant action. |
| DL-002 | COMMISSION_RATE constant lives in a new file src/domain/payments/commission.ts, not in src/domain/payments/events.ts, src/domain/orders/pricing.ts, or a generic kernel constants module. | events.ts file-level doc declares its purpose as Domain event types for PayMongo webhook-driven payment transitions (interface contracts only) -> mixing a numeric arithmetic constant into an event-types file dilutes file purpose. pricing.ts is rejected as the host because pricing.ts owns the pricing-mode mapping for client-facing service prices (a different concern from PipetGo commission rate split); colocating commission with pricing would conflate two independent rate concepts (lab service price vs PipetGo commission). A generic kernel constants module (e.g. src/domain/constants.ts) is rejected because the kernel pattern is one concept per file (state-machine.ts owns transitions; client-details.ts owns the Zod schema; pricing.ts owns the pricing-mode mapping); a catch-all constants file is the anti-pattern this convention exists to prevent. commission.ts as a sibling file under src/domain/payments/ matches the established kernel pattern, keeps events.ts focused on type contracts, and keeps the kernel under the 300-line budget. The new file is approximately 15 lines (one constant + one comment block), well within the ADR-001 size constraint. |
| DL-003 | Payout commission record is created inside the existing completeOrder $transaction in the same prisma.$transaction callback as the Order COMPLETED update, not in a separate post-commit step or fan-out handler | The acceptance criterion (docs/roadmap.md T-09) requires Payout creation inside the same $transaction as the Order COMPLETED update -> a separate post-commit step would create a window where Order is COMPLETED with no Payout, breaking the T-10 invariant that every COMPLETED order has a QUEUED Payout to settle -> a fan-out handler (analogous to handle-payment-captured) is overhead with no second reader (lab-fulfillment is the only writer; T-10 will be the only later reader). Inlining inside completeOrder's existing $transaction reuses the TOCTOU re-fetch transaction boundary and adds one tx.payout.create call with no new control flow. This matches the T-08 DL-007 precedent: a one-slice fan-out is overhead with no readers. |
| DL-004 | completeOrder fetches the CAPTURED Transaction via tx.transaction.findFirst on the composite (orderId, status) index, not findUnique, and throws if absent | Transaction has no @unique on orderId (an order may have multiple Transaction rows — T-08 retry creates new PENDING rows on retry, leaving the prior FAILED row in place) -> findUnique on (orderId, status) is not available because that combination is an @@index not an @unique constraint -> findFirst on the @@index([orderId, status]) is the correct query. At COMPLETED time the state machine (src/domain/orders/state-machine.ts canTransition table) guarantees the order passed through ACKNOWLEDGED -> IN_PROGRESS, which only happens after handlePaymentCaptured wrote a CAPTURED Transaction (handle-payment-captured/handler.ts advances Order PENDING_PAYMENT -> ACKNOWLEDGED after Transaction.status=CAPTURED). The exactly-one-CAPTURED-Transaction-per-orderId invariant therefore holds at completeOrder entry: payment-capture is idempotent (handlers.ts processPaymentCapture returns early if Transaction.status is already CAPTURED, never creating a second), so the universe of CAPTURED Transaction rows for a given orderId is exactly one. Absence is a contract violation per Implementation Discipline, so the handler throws new Error rather than returning a soft failure. findFirst here matches the codebase pattern of findFirst on composite indexes (no @unique) — handlers.ts uses findUnique only on the @unique externalId. |
| DL-005 | COMMISSION_RATE = new Decimal('0.1000') stored as a fraction with four-decimal scale matching prisma Payout.feePercentage Decimal(5,4) | prisma/schema.prisma:276 declares feePercentage as Decimal(5,4) -> the schema reserves four decimal places of scale, supporting rates expressed as a fraction (e.g. 0.1000 = 10%) -> writing the constant as a string-constructed Decimal'0.1000' (not new Decimal(0.1) which inherits float drift) preserves exact precision and is read-trivially as ten percent. Future per-lab rates (Payout.feePercentage field) and any rate change inherit the same fraction-with-four-decimals semantics. The TODO comment in commission.ts records that the launch-MVP rate is a single global 10 percent and a future ticket will source it from a config table once contract negotiation requires it. |
| DL-006 | Fee arithmetic uses Decimal.mul and Decimal.sub on Prisma Decimal instances throughout; no Number coercion at any step, including the Payout.feePercentage write. | Prisma Decimal class (@prisma/client/runtime/library) preserves exact arithmetic; Number arithmetic on currency values introduces floating-point drift on amounts as small as 1500.00 * 0.1 -> any intermediate conversion to Number invalidates the gross == platformFee + netAmount invariant that T-10 settlement and BIR reporting depend on -> the only correct pattern is capturedTransaction.amount.mul(COMMISSION_RATE) for platformFee and capturedTransaction.amount.sub(platformFee) for netAmount. The Payout.feePercentage write (column type Decimal(5,4) in prisma/schema.prisma:276) MUST also receive COMMISSION_RATE as a Decimal — not the literal number 0.1 — even though Prisma accepts number-or-string-or-Decimal for Decimal columns, because passing a number reintroduces the float source the rest of this rule excludes (e.g. a future refactor that converts COMMISSION_RATE to a number would silently break only at this write site, hardest to detect). The correct call is feePercentage: COMMISSION_RATE with COMMISSION_RATE being the Decimal exported from commission.ts. Prisma write expects Decimal or string; both are supported. This decision implements the context.json MUST: All fee arithmetic uses Decimal. |
| DL-007 | Payout.status is initialized to QUEUED at creation in completeOrder; the COMPLETED transition is owned by T-10 (settlement webhook) | PayoutStatus enum in prisma/schema.prisma includes QUEUED, COMPLETED, FAILED -> QUEUED means commission is confirmed (order completed) but Xendit settlement has not been confirmed yet; COMPLETED means settlement webhook has fired -> at completeOrder time only the first is true (Xendit settlement happens minutes-to-days later out of band) -> writing COMPLETED here would shortcut the settlement lifecycle and break T-10's idempotency (the settlement webhook would see an already-COMPLETED Payout and become a no-op for legitimate settlements). QUEUED is the only correct initial state. T-10 owns the QUEUED -> COMPLETED transition. |
| DL-008 | The existing tests/handlers.test.ts blocks 1-3 (which assert LabWallet IS credited) are rewritten in-place to assert LabWallet remains null after processPaymentCapture, not deleted | The three tests cover three distinct invariant paths: first-payment-no-wallet-row, subsequent-payment-pre-existing-row, and idempotency-when-Transaction-already-CAPTURED -> these path coverages remain meaningful under AD-001 (the question is just whether the wallet stays null/unchanged, not whether it is credited) -> deleting them loses path coverage; rewriting flips the expectation while preserving the path. After T-09 each test asserts: (a) the Transaction is CAPTURED, (b) handlePaymentCaptured advanced the Order, (c) labWallet.findUnique returns null (test 1 and 3) or remains at its seeded value (test 2 — pre-existing wallet row stays at 500.00, not 2000.00). The four-block test for completeOrder Payout creation is added as a new fourth describe block in the same file. |
| DL-009 | handlers-rollback.test.ts drops its labWallet.upsert mock and its order.findUnique-for-labId mock from the processPaymentCapture path; the test's assertion target shifts from wallet failure to a different forced-throw path | Pre-T-09, the mock-based rollback test forces tx.labWallet.upsert to reject with wallet failure to verify error propagation -> after handlers.ts no longer calls labWallet.upsert, the mock is unreachable code and the assertion fails for the wrong reason (the call simply does not happen) -> the test must either be retargeted to a still-present call site or deleted. Retargeting to tx.transaction.update rejection preserves the rollback-error-propagation coverage for processPaymentCapture without requiring a new test scenario. The processPaymentFailed rollback test is unaffected (no LabWallet write in that path). |
| DL-010 | lab-fulfillment's completeOrder receives one new ledger write (Payout.create) but the slice does not gain a payments cross-slice import path; commission constant is imported from @/domain/payments/commission (kernel, not slice) | ADR-001 slice boundary rule: feature slices may import from domain kernel but not from each other -> Payout is a Prisma model owned by the schema (not a feature slice), so writing tx.payout.create from inside completeOrder is a schema-level read/write not a cross-slice call -> the only added import is @/domain/payments/commission for the rate, which is kernel-level and allowed. Reading the Transaction via tx.transaction.findFirst is likewise a schema-level read (Prisma model), not a cross-slice import of payments code. The slice gains no @/features/payments/* import; the cross-cutting concern stays inside the domain kernel. |
| DL-011 | Inside completeOrder $transaction the operation order is: Order.update(COMPLETED) FIRST, then tx.transaction.findFirst(CAPTURED), then tx.payout.create — not the fail-fast reverse order. | completeOrder already runs a TOCTOU re-fetch + isValidStatusTransition guard BEFORE the tx.order.update, so by the time control reaches the update the IN_PROGRESS->COMPLETED transition is known valid -> placing the Order.update first keeps the existing diff small (one inserted block AFTER the update, no reordering of pre-existing lines) and preserves the canonical pattern used elsewhere in the slice (status write, then ledger writes). Reversing to fetch-Transaction first would gain nothing (the throw on null is still the same point of failure, and CAPTURED is invariant by this stage) but would require relocating the Order.update inside the new block, creating a larger and riskier diff. Documenting the intentional ordering prevents a future contributor from swapping the two thinking it is a fail-fast improvement. |
| DL-012 | Payout.labId is sourced from order.lab.id (the included Lab relation), not from order.labId (the scalar FK). | completeOrder already loads the Order with lab: true include (used by the auth/ownership check that verifies userLabId === order.lab.userId) -> order.lab.id is already in memory, no additional Prisma read needed; using the scalar order.labId would be equivalent but unnecessarily reaches for the FK column when the relation object is already loaded. Both produce identical writes (lab.id === labId by Prisma invariant on the FK relationship). Choosing order.lab.id keeps the code adjacent to the same object used by the ownership check, improving local readability and signalling that the lab loaded for authorisation is the same lab written to the Payout. |
| DL-013 | Transaction.amount used as Payout.grossAmount is sourced as a Prisma Decimal column per prisma/schema.prisma:247 (amount Decimal @db.Decimal(12,2)); no toNumber() coercion at the call site. | schema.prisma:247 declares Transaction.amount as Decimal(12,2) and Prisma client returns it as a Decimal instance from @prisma/client/runtime/library -> capturedTransaction.amount is a Decimal in TypeScript at the boundary, so DL-006 Decimal arithmetic discipline (mul/sub) applies natively without coercion; reading the amount as a plain Number (via .toNumber() or implicit coercion) would re-introduce the float drift DL-006 forbids. Recording the schema source (schema.prisma:247) makes the assumption auditable and lets reviewers verify the column shape without re-reading schema. |
| DL-014 | No Payout backfill for pre-T-09 COMPLETED orders. Production has zero historical COMPLETED orders before T-09 ships (pre-launch state). T-10 implementors can assume every COMPLETED order from T-09 onward has exactly one Payout. | Production database state at T-09 ship time: zero Orders in COMPLETED status (the lab fulfillment flow has not been used in production prior to T-09 — this is a pre-launch ticket) -> no historical rows exist that would require a backfill migration; the empty backfill is correct by construction, not by negligence. Recording this explicitly prevents T-10 implementors from defensively handling a never-occurring case (COMPLETED order without Payout) or from authoring an unnecessary backfill script. If pre-launch state ever changes (e.g. staging seed data with COMPLETED rows), this decision must be revisited; the absence-of-Payout assumption is contingent on the empty pre-launch state. |
| DL-015 | completeOrder is protected against double-execution (double-click, retry, parallel POSTs) by the existing TOCTOU re-fetch + isValidStatusTransition guard inside the $transaction; no additional Payout uniqueness check is needed. | completeOrder reads Order with FOR UPDATE semantics inside prisma.$transaction (re-fetch), then calls isValidStatusTransition(currentStatus, COMPLETED) -> a second invocation finds Order.status === COMPLETED on the re-fetch, isValidStatusTransition returns false, the action throws before tx.order.update and before tx.payout.create -> the same $transaction-scoped guard that prevents double Order updates also prevents double Payout writes. Adding a Payout @unique on orderId would be defence-in-depth but is rejected as overhead because the application-layer guard is sufficient, the Payout schema is already shipped without that constraint, and a constraint addition is a separate schema-migration ticket. |
| DL-016 | handlePaymentCaptured (src/features/payments/webhooks/handle-payment-captured/handler.ts) MUST NOT create a Payout record. Payout creation is exclusive to completeOrder. | AD-001 commission timing semantics: a Payout represents commission CONFIRMED at order completion (IN_PROGRESS->COMPLETED), not commission collectable at payment capture; the lab may issue a refund or the order may fail lab fulfillment, so capture-time Payout creation would produce phantom commission rows -> DL-003 places the single Payout write inside completeOrder. Recording this as an explicit prohibition (rather than an implicit consequence of DL-003) prevents a future contributor from extending handlePaymentCaptured to write Payout under the mistaken assumption that capture is the natural commission-creation moment, which would produce duplicate Payout rows (one from the webhook handler, one from completeOrder) for every order that reaches COMPLETED. |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Create the Payout record at payment capture time inside processPaymentCapture | Payout represents confirmed commission on order completion (IN_PROGRESS to COMPLETED), not at payment capture. The lab may issue a refund or the order may never reach COMPLETED (cancelled, FAILED_LAB_FULFILLMENT), in which case a Payout written at capture would be a phantom commission record. Deferring Payout creation to completeOrder ties the record to the lifecycle moment when commission is actually confirmed. (ref: DL-001) |
| Per-lab or per-service commission rates sourced from Lab.commissionRate or a contract table | Deferred. A single global commission rate is sufficient for launch MVP; per-lab variation is a contract-negotiation concern that will arrive after MVP. The COMMISSION_RATE constant in src/domain/payments/commission.ts carries a TODO referencing the future column/table source so the migration path is documented. (ref: DL-005) |
| Extend src/domain/payments/events.ts with the COMMISSION_RATE constant | events.ts file-level doc declares its purpose as Domain event types for PayMongo webhook-driven payment transitions (interface contracts only). Mixing a numeric arithmetic constant into an event-types file dilutes file purpose and breaks the single-responsibility pattern. A sibling file commission.ts is the cleaner separation and matches the established kernel pattern of one concept per file (state-machine.ts owns transitions, client-details.ts owns the Zod schema, pricing.ts owns pricing-mode mapping). (ref: DL-002) |

### Constraints

- Payout creation MUST occur inside the same prisma.$transaction callback as the Order COMPLETED update so the COMPLETED-state and the QUEUED-Payout atomicity invariant holds (no window where Order is COMPLETED without a Payout).
- All commission/fee arithmetic MUST use Prisma Decimal (mul, sub) end-to-end. No Number coercion, no parseFloat, no toNumber() intermediate, to preserve the gross == platformFee + netAmount invariant T-10 settlement and BIR reporting depend on.
- The COMMISSION_RATE constant MUST live in the domain kernel at src/domain/payments/commission.ts, not hardcoded inside src/features/orders/lab-fulfillment/action.ts; slice code MAY import kernel constants but MUST NOT own them (ADR-001).
- The LabWallet.pendingBalance upsert and the surrounding order.findUnique fetch MUST be removed entirely from src/features/payments/webhooks/handlers.ts:processPaymentCapture; not relocated, not feature-flagged, not commented out.
- Webhook integration tests in src/features/payments/webhooks/__tests__/handlers.test.ts MUST be updated so the first three describe blocks assert LabWallet remains null (or seeded value unchanged) after processPaymentCapture; path coverage of first-payment, subsequent-payment, idempotent-capture is preserved by inverting expectations rather than deletion.
- Payout.status MUST be initialized to PayoutStatus.QUEUED at creation in completeOrder; the QUEUED to COMPLETED transition is owned exclusively by T-10 (settlement webhook).
- Implementation Discipline: an absent CAPTURED Transaction at completeOrder time is a contract violation per the state machine and MUST throw new Error rather than fall through, silently default, or return a soft failure.
- Implementation Discipline: Prisma lookups on @unique fields MUST use findUnique; lookups on @@index composite keys (such as Transaction(orderId,status)) MAY use findFirst since no @unique constraint exists, but the intent must be explicit.

### Known Risks

- **T-10 (settlement webhook) depends on QUEUED Payout rows existing for COMPLETED orders. If T-09 ships without T-10, QUEUED Payouts accumulate until T-10 lands; if T-09 introduces a bug that fails to create the Payout, T-10 reads an empty set and silently no-ops.**: Acceptance criterion in M-003 explicitly asserts Payout row exists with status QUEUED, transactionId, and the Decimal split values; the second M-003 test asserts completeOrder rejects when no CAPTURED Transaction exists. Both guarantee the contract T-10 will consume.
- **Pre-T-09 COMPLETED orders (if any) have no Payout row; backfill policy for historical data is ambiguous and T-10 readers may break when they encounter a COMPLETED order without a Payout.**: Decision DL-014 records the policy: no backfill required because production has zero COMPLETED orders prior to T-09 (pre-launch). T-10 implementors can assume every COMPLETED order produced from T-09 onward has exactly one Payout; the historical-data shape is explicitly empty.
- **completeOrder running twice for the same order (double-click on Mark Complete UI, retry on transient error, parallel POSTs) could create duplicate Payout rows since Payout has no @unique on orderId.**: completeOrder's existing TOCTOU re-fetch checks Order.status === IN_PROGRESS inside the $transaction; isValidStatusTransition rejects IN_PROGRESS to COMPLETED on the second call (current status is already COMPLETED), throwing before Payout.create runs. The same $transaction boundary that protects the status transition also protects Payout uniqueness. Decision DL-015 records this guard reasoning.
- **After Payout is QUEUED, a downstream refund or chargeback on the captured Transaction would require reversing the Payout; current schema has no reversal field and no slice handles refunds.**: Out of scope for T-09. Refund/chargeback handling is a separate ticket whose plan must add a Payout reversal status (PayoutStatus.REVERSED) or a credit Payout row. Recorded as a risk so T-10 implementors and future refund-feature implementors do not silently inherit the assumption that QUEUED is terminal-on-the-failure-side.
- **Stale LabWallet.pendingBalance rows written by the prior aggregator-era processPaymentCapture code (CAPTURED-but-not-COMPLETED Transactions whose handler ran before T-09) could be misread by T-10 implementors as legitimate commission ledger entries, since after T-09 ships LabWallet IS the commission ledger but its pre-T-09 contents are aggregator-era escrow amounts (full Transaction.amount, not commission slice).**: Production database state at T-09 ship time: zero LabWallet rows with non-zero pendingBalance (pre-launch — handle-payment-captured/processPaymentCapture has not run in production prior to T-09). Combined with KR-002 (zero historical COMPLETED orders), this guarantees no stale aggregator-era LabWallet writes exist. If pre-launch state ever changes (e.g. staging seed data, accidental dev-DB promotion), T-10 implementors MUST treat any pre-T-09 LabWallet.pendingBalance row as legacy aggregator-era data (escrow amount, NOT commission) and zero it before settlement. Recorded as a risk so T-10 does not inherit the assumption that all existing LabWallet rows are AD-001-shaped commission data.

## Invisible Knowledge

### System

AD-001 Direct Payment: the client pays the lab directly via a Xendit Managed Sub-Account invoice (lab is the merchant of record). Xendit performs the commission split at settlement time, so PipetGo never holds or disburses the gross amount. PipetGo's books track only the commission slice. Under this model the LabWallet table, originally authored to track lab escrow under an aggregator-payments assumption, is repurposed as PipetGo's per-lab commission ledger: pendingBalance = commission confirmed but not yet settled by Xendit; availableBalance = commission settled (populated by T-10 settlement webhook). The Payout table is the per-order commission settlement record (PipetGo's confirmed commission for one order), NOT a disbursement record (PipetGo paying the lab) — under AD-001 PipetGo never disburses to the lab because the lab already holds the gross amount via Xendit sub-account. Fee math (Decimal-only): platformFee = grossAmount.mul(COMMISSION_RATE); netAmount = grossAmount.sub(platformFee); the invariant gross == platformFee + netAmount holds exactly because no Number coercion occurs. Roadmap context: the pre-T-09 LabWallet.pendingBalance upsert in processPaymentCapture is a known inconsistency documented in docs/roadmap.md AD-001 — the code was authored under the prior aggregator assumption (PipetGo as escrow holder) and T-09 is the scoped ticket to delete it; T-09 does NOT re-introduce a different LabWallet write at capture, the entire concept of crediting LabWallet at payment capture is wrong under AD-001.

### Invariants

- AD-001 Direct Payment: Xendit Managed Sub-Accounts split commission at settlement; the lab already receives the full payment amount at capture; PipetGo never holds the gross.
- LabWallet under AD-001 is PipetGo's commission ledger per lab (NOT lab escrow). pendingBalance = confirmed commission, availableBalance = settled commission (populated by T-10).
- Payout under AD-001 is the per-order commission settlement record — PipetGo's confirmed commission slice for that single order. Payout is NOT a disbursement record (PipetGo does not pay the lab; the lab already received the gross via Xendit sub-account split at capture). This semantic distinction is critical: implementors who assume Payout = disbursement will write the wrong amount (gross instead of platformFee) and the wrong direction (PipetGo->lab instead of PipetGo's own commission ledger).
- Every Order transitioning to COMPLETED MUST produce exactly one Payout in status QUEUED inside the same prisma.$transaction. The state machine guarantees a CAPTURED Transaction exists at this point (handlePaymentCaptured runs before lab fulfillment); absence is a contract violation.
- Fee formula (Decimal-only): platformFee = grossAmount.mul(COMMISSION_RATE); netAmount = grossAmount.sub(platformFee). All three of grossAmount, platformFee, netAmount are Prisma Decimal instances end-to-end with no Number/toNumber()/parseFloat coercion at any step. Decimal.feePercentage column is Decimal(5,4) so the constant is written as new Decimal('0.1000') (string-constructed to avoid float drift). The invariant gross == platformFee + netAmount holds exactly under Decimal arithmetic and is the basis of T-10 settlement reconciliation and BIR commission reporting.

### Tradeoffs

- Roadmap AD-001 known-inconsistency context: the LabWallet.pendingBalance upsert in processPaymentCapture is a known inconsistency documented in docs/roadmap.md AD-001 section — the code was authored under the prior aggregator assumption (PipetGo as escrow holder, holding the gross amount and disbursing to the lab minus commission), and T-09 is the ticket specifically scoped to remove it and align the codebase with AD-001 Direct Payment semantics. Recording this in invisible_knowledge prevents future contributors from re-introducing the upsert under the mistaken belief that the wallet credit is missing or that LabWallet should be credited at capture.
- Inlining Payout.create inside completeOrder (rather than emitting an OrderCompleted domain event with a payments-slice listener) accepts coupling between lab-fulfillment slice and the Payout Prisma model. This is acceptable under ADR-001 because Payout is a kernel-level schema model, not a feature slice, and there is exactly one writer (completeOrder) and one later reader (T-10 settlement webhook) — a fan-out abstraction has no readers to justify it. This follows the T-08 DL-007 precedent.
- Using findFirst on Transaction(orderId, status: CAPTURED) is the correct query because no @unique constraint exists on that composite (orderId can have multiple Transactions across retries; only one is CAPTURED). findUnique is unavailable; the @@index makes the lookup efficient. The explicit throw on null preserves the uniqueness contract at the application layer where the schema cannot.

## Milestones

### Milestone 1: Domain kernel: COMMISSION_RATE constant

**Files**: src/domain/payments/commission.ts

**Requirements**:

- Export COMMISSION_RATE as Decimal('0.1000') with TODO comment for future rate-source decision
- Import Decimal from @prisma/client/runtime/library matching events.ts and pricing.ts pattern
- File body stays under 20 lines (ADR-001 kernel size budget)

**Acceptance Criteria**:

- npx tsc --noEmit passes
- npx eslint src/domain/ passes (no kernel boundary violations)
- COMMISSION_RATE imported by lab-fulfillment/action.ts resolves to a Decimal value of 0.1000
- Domain kernel total line count remains under 300 lines

#### Code Intent

- **CI-M-001-001** `src/domain/payments/commission.ts::COMMISSION_RATE`: Module exports COMMISSION_RATE as a Prisma Decimal constructed from the string literal 0.1000 (fraction; ten percent). The file opens with a file-level JSDoc block describing the AD-001 context — that COMMISSION_RATE is the launch-MVP single global commission rate, with a TODO referencing a future per-lab or per-service rate source (Lab.commissionRate column or contract table) once contract negotiation requires variation. The Decimal import comes from @prisma/client/runtime/library matching the existing pattern in src/domain/payments/events.ts and src/domain/orders/pricing.ts. The constant is named COMMISSION_RATE (uppercase snake-case for module-level constants) and is the only export. (refs: DL-002, DL-005)

#### Code Changes

**CC-M-001-001** (src/domain/payments/commission.ts) - implements CI-M-001-001

**Code:**

```diff
--- /dev/null
+++ src/domain/payments/commission.ts
@@ -0,0 +1,14 @@
+/**
+ * Commission rate constants for the AD-001 Direct Payment model.
+ *
+ * COMMISSION_RATE is the launch-MVP single global commission rate applied to
+ * every completed order. Xendit splits this at settlement; the Payout record
+ * captures the confirmed commission at order completion.
+ *
+ * TODO: replace with per-lab or per-service rate from Lab.commissionRate column
+ * or a contract table once contract negotiation requires variation.
+ */
+import { Decimal } from "@prisma/client/runtime/library";
+
+export const COMMISSION_RATE = new Decimal("0.1000");

```

**Documentation:**

```diff
--- a/src/domain/payments/commission.ts
+++ b/src/domain/payments/commission.ts
@@ -1,14 +1,14 @@
 /**
  * Commission rate constants for the AD-001 Direct Payment model.
  *
- * COMMISSION_RATE is the launch-MVP single global commission rate applied to
- * every completed order. Xendit splits this at settlement; the Payout record
- * captures the confirmed commission at order completion.
+ * Under AD-001, Xendit Managed Sub-Accounts split the PipetGo commission at
+ * settlement. COMMISSION_RATE is the single global rate applied to every
+ * completed order; the Payout record captures confirmed commission when an
+ * order reaches COMPLETED.
  *
- * TODO: replace with per-lab or per-service rate from Lab.commissionRate column
- * or a contract table once contract negotiation requires variation.
+ * TODO: per-lab or per-service rates from Lab.commissionRate or a contract
+ * table — deferred until contract negotiation requires variation. (ref: DL-002)
  */
 import { Decimal } from "@prisma/client/runtime/library";
 
+// String-constructed to preserve exact scale matching Payout.feePercentage Decimal(5,4). (ref: DL-005)
 export const COMMISSION_RATE = new Decimal("0.1000");

```


**CC-M-001-002** (src/domain/payments/CLAUDE.md)

**Documentation:**

```diff
--- a/src/domain/payments/CLAUDE.md
+++ b/src/domain/payments/CLAUDE.md
@@ -1,10 +1,12 @@
 # payments/
 
-Domain event types for PayMongo webhook-driven payment transitions.
+Domain event types and commission constants for payment processing.
 
 ## Files
 
 | File            | What                                                           | When to read                                                      |
 | --------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
 | `events.ts`     | `PaymentCapturedEvent` and `PaymentFailedEvent` interface types | Implementing webhook handlers; dispatching payment events to feature slices |
+| `commission.ts` | `COMMISSION_RATE` — global commission rate Decimal constant for AD-001 Direct Payment fee arithmetic | Implementing Payout creation or modifying commission rate |

```


**CC-M-001-003** (src/domain/CLAUDE.md)

**Documentation:**

```diff
--- a/src/domain/CLAUDE.md
+++ b/src/domain/CLAUDE.md
@@ -7,6 +7,6 @@
 | Directory    | What                                                          | When to read                                          |
 | ------------ | ------------------------------------------------------------- | ----------------------------------------------------- |
 | `orders/`    | State machine, client validation schema, pricing logic        | Any slice that writes `Order.status` or creates orders |
-| `payments/`  | PayMongo webhook event types                                  | Implementing payment webhook handlers                 |
+| `payments/`  | Payment event types and commission rate constant              | Implementing payment webhook handlers or Payout creation |

```


### Milestone 2: Webhook handler: remove LabWallet credit (AD-001 alignment)

**Files**: src/features/payments/webhooks/handlers.ts, src/features/payments/webhooks/__tests__/handlers.test.ts, src/features/payments/webhooks/__tests__/handlers-rollback.test.ts, src/features/payments/webhooks/README.md, src/features/payments/webhooks/CLAUDE.md

**Requirements**:

- processPaymentCapture contains no tx.labWallet write of any kind
- processPaymentCapture contains no order.findUnique call (the call was only needed for labId)
- Transaction.update path, handlePaymentCaptured dispatch, and the three early-return guards (orphan, idempotency-CAPTURED, refuse-FAILED) remain unchanged
- handlers.test.ts blocks 1-3 invert their LabWallet assertions to assert null or unchanged after capture
- handlers-rollback.test.ts processPaymentCapture test target shifts to tx.transaction.update rejection (still verifying rollback propagation)

**Acceptance Criteria**:

- npx tsc --noEmit passes
- npm test -- --run passes (all handler tests green)
- processPaymentCapture body reduced by approximately 25 lines (LabWallet upsert + order fetch + labId-not-found throw removed)
- handlers.test.ts test 1 asserts labWallet.findUnique returns null after processPaymentCapture
- handlers.test.ts test 2 asserts pre-existing LabWallet row remains at seeded balance (500.00 unchanged)
- handlers.test.ts test 3 asserts labWallet remains null after idempotent capture
- handlers-rollback.test.ts processPaymentCapture suite passes with retargeted mock

#### Code Intent

- **CI-M-002-001** `src/features/payments/webhooks/handlers.ts::processPaymentCapture`: processPaymentCapture retains its $transaction body up to and including handlePaymentCaptured(event, tx). The trailing block — Fetch Order for labId tx.order.findUnique, the Order not found throw, and the tx.labWallet.upsert — is removed entirely. The function ends immediately after handlePaymentCaptured(event, tx). The PaymentCapturedEvent construction remains unchanged (still passes amount, orderId, transactionId, gatewayRef, capturedAt, paymentMethod). The file-level JSDoc and function-level JSDoc are updated to drop references to LabWallet crediting; they reflect that the handler performs Transaction.update + Order fan-out only (no wallet write, no Payout write — per DL-016, Payout creation is exclusive to completeOrder, so handlePaymentCaptured MUST NOT be extended to write Payout). Imports remain unchanged except no new symbols are added; the TransactionStatus import stays. processPaymentFailed is unchanged. (refs: DL-001, DL-016)
- **CI-M-002-002** `src/features/payments/webhooks/__tests__/handlers.test.ts`: Test block 1 (creates LabWallet with pendingBalance equal to Transaction.amount on first payment) is renamed to advances Transaction to CAPTURED and does not credit LabWallet on first payment under AD-001. Its assertions invert: testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } }) returns null; testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_1 } }).status equals CAPTURED. Test block 2 (increments pendingBalance on subsequent payment) is renamed to leaves pre-existing LabWallet row balance unchanged under AD-001. Its setup still seeds a LabWallet with pendingBalance 500.00; the assertion changes from 2000.00 to 500.00 (unchanged). Test block 3 (returns early without crediting LabWallet when already CAPTURED) keeps its assertion expect(wallet).toBeNull() — it already aligns with AD-001. The processPaymentCapture describe block contains four tests after M-002 and M-003 land; the new fourth test belongs to M-003. processPaymentFailed describe block is unchanged. (refs: DL-001, DL-008)
- **CI-M-002-003** `src/features/payments/webhooks/__tests__/handlers-rollback.test.ts`: The mockTxLabWalletUpsert and the labWallet field on mockTx are removed. The mockTxOrderFindUnique is removed (handlers.ts no longer calls tx.order.findUnique inside processPaymentCapture). The processPaymentCapture rollback test changes its forced-throw source from tx.labWallet.upsert to tx.transaction.update (rename mockTxUpdate to mockTxTransactionUpdate and make it reject with the error string transaction update failure); the assertion becomes await expect(processPaymentCapture(payload)).rejects.toThrow(transaction update failure). The processPaymentFailed rollback test is unchanged in shape, but the shared mockTx structure is updated so it remains valid (order.update still rejects with order update failure). The vi.mock for @/domain/orders/state-machine remains. (refs: DL-009)
- **CI-M-002-004** `src/features/payments/webhooks/README.md`: The Request flow section step 4 (handlers.ts:processPaymentCapture runs a Prisma $transaction (PAID path)) loses its last two bullets (Fetches Order.labId, Upserts LabWallet.pendingBalance). The Invariants section loses the LabWallet.pendingBalance is credited at capture bullet, the LabWallet upsert uses upsert (not update) bullet, and the LabWallet.labId is @unique bullet. A new bullet documents the AD-001 invariant: webhook capture writes only Transaction.status and Order.status; commission settlement is tracked via Payout records created at order completion, not at payment capture. The Design decisions section LabWallet credit is inlined in handlers.ts block is replaced with a paragraph naming the AD-001 decision and pointing readers to docs/roadmap.md AD-001 and src/features/orders/lab-fulfillment/ for the new Payout write site. The Test strategy table loses the wallet-creation and balance-increment scenarios from its tests 1-2 row; those rows describe the inverted AD-001 assertions instead. (refs: DL-001)
- **CI-M-002-005** `src/features/payments/webhooks/CLAUDE.md`: The handlers.ts row (Contents column) drops the LabWallet credit fragment. Updated text reads: processPaymentCapture (PAID) — Transaction CAPTURED, Order fan-out; processPaymentFailed (EXPIRED) — Transaction FAILED, Order PAYMENT_FAILED, no wallet write. The When to read column drops lab wallet crediting. No other table rows or sections change. (refs: DL-001)

#### Code Changes

**CC-M-002-001** (src/features/payments/webhooks/handlers.ts) - implements CI-M-002-001

**Code:**

```diff
--- src/features/payments/webhooks/handlers.ts
+++ src/features/payments/webhooks/handlers.ts
@@ -1,7 +1,7 @@
 /**
  * Payment capture and failure processors for Xendit invoice webhooks.
  *
- * processPaymentCapture and processPaymentFailed run all DB writes inside a single Prisma $transaction.
- * Any throw at any step rolls back all writes; Xendit retries on 500 reattempt the full capture.
+ * processPaymentCapture and processPaymentFailed run all DB writes inside a single Prisma $transaction.
+ * Any throw at any step rolls back all writes; Xendit retries on 500 reattempt the full capture.
  * (ref: DL-001, DL-004, DL-006)
  */
@@ -15,12 +15,9 @@
 /**
- * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, dispatches
- * PaymentCapturedEvent to the orders slice handler, and credits the lab's
- * LabWallet.pendingBalance by Transaction.amount — all within one $transaction.
- * Credits LabWallet.pendingBalance atomically after Order status transition. (ref: DL-002, DL-005)
+ * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, and dispatches
+ * PaymentCapturedEvent to the orders slice handler — all within one $transaction.
+ * No wallet write; commission is tracked via Payout at order completion. (ref: DL-001, DL-016)
  *
- * Returns early (200 to caller) if Transaction is not found (orphan tolerance) or
- * already CAPTURED (idempotency). Both guards are inside the transaction boundary
- * to prevent race conditions from concurrent webhook deliveries; retried Xendit requests
- * exit before the LabWallet upsert, preventing double-credit. (ref: DL-004, DL-007)
+ * Returns early (200 to caller) if Transaction is not found (orphan tolerance) or
+ * already CAPTURED (idempotency). Both guards are inside the transaction boundary
+ * to prevent race conditions from concurrent webhook deliveries. (ref: DL-004, DL-007)
  */
@@ -71,22 +68,5 @@
     // Delegates Order.status transition to orders slice — ADR-001 fan-out pattern. (ref: DL-001)
     await handlePaymentCaptured(event, tx)
-
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
@@ -15,11 +15,11 @@
 /**
- * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, and dispatches
- * PaymentCapturedEvent to the orders slice handler — all within one $transaction.
- * No wallet write; commission is tracked via Payout at order completion. (ref: DL-001, DL-016)
+ * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, and dispatches
+ * PaymentCapturedEvent to the orders slice handler — all within one $transaction.
+ * No LabWallet write; commission is tracked via Payout records created inside
+ * completeOrder at order completion. (ref: DL-001, DL-016)
  *
  * Returns early (200 to caller) if Transaction is not found (orphan tolerance) or
  * already CAPTURED (idempotency). Both guards are inside the transaction boundary
- * to prevent race conditions from concurrent webhook deliveries. (ref: DL-004, DL-007)
+ * to prevent race conditions from concurrent Xendit deliveries. (ref: DL-004, DL-007)
  */

```


**CC-M-002-002** (src/features/payments/webhooks/__tests__/handlers.test.ts) - implements CI-M-002-002

**Code:**

```diff
--- src/features/payments/webhooks/__tests__/handlers.test.ts
+++ src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -78,37 +78,40 @@
 describe('processPaymentCapture', () => {
-  it('creates LabWallet with pendingBalance equal to Transaction.amount on first payment', async () => {
+  it('advances Transaction to CAPTURED and does not credit LabWallet on first payment under AD-001', async () => {
     await testPrisma.order.create({
       data: {
         id: TEST_ORDER_ID_1,
         clientId: TEST_USER_CLIENT_ID,
         labId: TEST_LAB_ID,
         serviceId: TEST_SERVICE_ID,
         status: OrderStatus.PAYMENT_PENDING,
         quantity: 1,
       },
     })
     await testPrisma.transaction.create({
       data: {
         id: 'test-tx-1',
         orderId: TEST_ORDER_ID_1,
         externalId: TEST_TX_EXTERNAL_ID_1,
         provider: 'xendit',
         amount: '1500.00',
         status: TransactionStatus.PENDING,
       },
     })
 
     const payload: XenditInvoicePayload = {
       id: TEST_TX_EXTERNAL_ID_1,
       status: 'PAID',
       paid_amount: 1500,
       payer_email: 'client@test.local',
       payment_method: 'CREDIT_CARD',
     }
 
     await processPaymentCapture(payload)
 
-    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
-    expect(wallet).not.toBeNull()
-    expect(wallet!.pendingBalance.toFixed(2)).toBe('1500.00')
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet).toBeNull()
+    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_1 } })
+    expect(tx!.status).toBe(TransactionStatus.CAPTURED)
   })
 
-  it('increments pendingBalance on subsequent payment', async () => {
+  it('leaves pre-existing LabWallet row balance unchanged under AD-001', async () => {
     await testPrisma.labWallet.create({
       data: { labId: TEST_LAB_ID, pendingBalance: '500.00' },
     })
     await testPrisma.order.create({
       data: {
         id: TEST_ORDER_ID_2,
         clientId: TEST_USER_CLIENT_ID,
         labId: TEST_LAB_ID,
         serviceId: TEST_SERVICE_ID,
         status: OrderStatus.PAYMENT_PENDING,
         quantity: 1,
       },
     })
     await testPrisma.transaction.create({
       data: {
         id: 'test-tx-2',
         orderId: TEST_ORDER_ID_2,
         externalId: TEST_TX_EXTERNAL_ID_2,
         provider: 'xendit',
         amount: '1500.00',
         status: TransactionStatus.PENDING,
       },
     })
 
     const payload: XenditInvoicePayload = {
       id: TEST_TX_EXTERNAL_ID_2,
       status: 'PAID',
       paid_amount: 1500,
       payer_email: 'client@test.local',
     }
 
     await processPaymentCapture(payload)
 
     const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
-    expect(wallet!.pendingBalance.toFixed(2)).toBe('2000.00')
+    expect(wallet!.pendingBalance.toFixed(2)).toBe('500.00')
   })

```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -78,4 +78,5 @@
 describe('processPaymentCapture', () => {
+  // Under AD-001 Direct Payment, processPaymentCapture must NOT write LabWallet. (ref: DL-001, DL-008)
   it('advances Transaction to CAPTURED and does not credit LabWallet on first payment under AD-001', async () => {

```


**CC-M-002-003** (src/features/payments/webhooks/__tests__/handlers-rollback.test.ts) - implements CI-M-002-003

**Code:**

```diff
--- src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
+++ src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
@@ -1,36 +1,28 @@
 import { describe, it, expect, vi } from 'vitest'
-import { Decimal } from '@prisma/client/runtime/library'
 import { OrderStatus, TransactionStatus } from '@prisma/client'
 
-const mockTxUpdate = vi.fn().mockResolvedValue({})
-const mockTxOrderFindUnique = vi.fn().mockResolvedValue({ id: 'mock-order-id', labId: 'mock-lab-id', status: OrderStatus.PAYMENT_PENDING })
+import { Decimal } from '@prisma/client/runtime/library'
+
+const mockTxTransactionUpdate = vi.fn().mockRejectedValue(new Error('transaction update failure'))
 const mockTxOrderUpdate = vi.fn().mockRejectedValue(new Error('order update failure'))
-const mockTxLabWalletUpsert = vi.fn().mockRejectedValue(new Error('wallet failure'))
 const mockTxTransactionFindUnique = vi.fn().mockResolvedValue({
   id: 'mock-tx-id',
   externalId: 'xendit-mock-ext',
   orderId: 'mock-order-id',
   amount: new Decimal('750.00'),
   status: TransactionStatus.PENDING,
 })
 
 const mockTx = {
   transaction: {
     findUnique: mockTxTransactionFindUnique,
-    update: mockTxUpdate,
+    update: mockTxTransactionUpdate,
   },
   order: {
-    findUnique: mockTxOrderFindUnique,
     update: mockTxOrderUpdate,
   },
-  labWallet: {
-    upsert: mockTxLabWalletUpsert,
-  },
 }
 
 vi.mock('@/lib/prisma', () => ({
   prisma: {
     $transaction: vi.fn((callback: (tx: typeof mockTx) => Promise<void>) => callback(mockTx)),
   },
 }))
@@ -48,7 +40,7 @@
 describe('processPaymentCapture — rollback error propagation', () => {
-  it('rejects with the wallet upsert error, confirming error propagation that triggers Prisma rollback', async () => {
+  it('rejects with the transaction update error, confirming error propagation that triggers Prisma rollback', async () => {
     const payload: XenditInvoicePayload = {
       id: 'xendit-mock-ext',
       status: 'PAID',
       paid_amount: 750,
       payer_email: 'lab@test.local',
     }
 
-    await expect(processPaymentCapture(payload)).rejects.toThrow('wallet failure')
+    await expect(processPaymentCapture(payload)).rejects.toThrow('transaction update failure')
   })
 })
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
@@ -40,4 +40,5 @@
 describe('processPaymentCapture — rollback error propagation', () => {
+  // Forces tx.transaction.update rejection to verify $transaction error propagation; no LabWallet mock needed under AD-001. (ref: DL-009)
   it('rejects with the transaction update error, confirming error propagation that triggers Prisma rollback', async () => {

```


**CC-M-002-004** (src/features/payments/webhooks/README.md) - implements CI-M-002-004

**Code:**

```diff
--- src/features/payments/webhooks/README.md
+++ src/features/payments/webhooks/README.md
@@ -18,8 +18,6 @@
    - Constructs `PaymentCapturedEvent` and calls `handlePaymentCaptured` from the
      orders slice inside the same transaction.
-   - Fetches `Order.labId` (read-consistent within same transaction). (ref: DL-004)
-   - Upserts `LabWallet.pendingBalance += Transaction.amount` (Decimal, not payload float) for the lab. (ref: DL-002, DL-003, DL-005)
 5. `handlers.ts:processPaymentFailed` runs a Prisma `$transaction` (EXPIRED path):
@@ -52,17 +50,8 @@
 ## Invariants
 
- Idempotency check (`findFirst` + status guard) is inside `$transaction` to
+ - Idempotency check (`findUnique` + status guard) is inside `$transaction` to
   prevent race conditions from concurrent Xendit deliveries. (ref: DL-004)
 - `PaymentCapturedEvent.amount` comes from `Transaction.amount` (Prisma `Decimal`),
   not `payload.paid_amount` (float). (ref: DL-005)
 - Order status transitions are owned by the orders slice — this handler never
   writes `Order.status` directly. (ref: DL-001)
-- `LabWallet.pendingBalance` is credited at capture time; `availableBalance` is only
-  incremented when a Payout reaches `COMPLETED`. Crediting `availableBalance` here would
-  skip the payout lifecycle. (ref: DL-002)
-- `LabWallet` upsert uses `upsert` (not `update`) — a row may not exist for a lab's
-  first payment. (ref: DL-005)
-- `LabWallet.labId` is `@unique` (prisma/schema.prisma:299); the Prisma `$transaction`
-  holds a row lock for the upsert, making concurrent webhook deliveries race-free — no
-  separate application-level guard is needed.
+- Webhook capture writes only `Transaction.status` and (via fan-out) `Order.status`;
+  commission settlement is tracked via Payout records created at order completion,
+  not at payment capture. (ref: DL-016)
 
 ## Design decisions
 
-**LabWallet credit is inlined in `handlers.ts`** rather than extracted to a separate
-`wallets/credit-wallet` slice. ADR-001 uses a `creditLabWallet` fan-out example that
-names a hypothetical `@/features/wallets/credit-wallet/handler` — that example is
-aspirational documentation for a future wallets slice, not a binding constraint. The
-implementation was deliberately scoped to the webhook slice only; extracting a wallets
-slice would introduce a new cross-slice import from payments to wallets, which is a
-larger architectural change requiring its own plan.
-
-**Order is fetched twice within the same `$transaction`** — once inside
-`handlePaymentCaptured` (for status transition) and once in `handlers.ts` (for
-`labId`). This double-read is an accepted tradeoff at MVP order volumes: PostgreSQL
-read-consistency guarantees both reads see the same snapshot at negligible cost. If
-needed, this can be eliminated later by returning `labId` from `handlePaymentCaptured`.
+**AD-001 Direct Payment**: Under the AD-001 model, the client pays the lab directly
+via Xendit Managed Sub-Account. The webhook handler's job is solely to advance
+Transaction and Order state. Commission tracking moves to `Payout` records created
+inside `completeOrder` — see `src/features/orders/lab-fulfillment/` and
+`docs/roadmap.md` AD-001 section.
 
 ## Required env vars
@@ -99,11 +84,11 @@
 | File | Tests | DB strategy | Why |
 |------|-------|-------------|-----|
-| `__tests__/handlers.test.ts` | 1-3: wallet creation, balance increment, idempotency | Real test database (`DATABASE_TEST_URL`) | Financial ledger correctness requires DB-level verification — mocking hides Decimal type mismatches and FK constraint errors |
-| `__tests__/handlers.test.ts` | 4: processPaymentCapture FAILED guard (EXPIRED-then-PAID race) | Real test database | Tests the guard that throws on FAILED transaction — same real-DB rationale |
+| `__tests__/handlers.test.ts` | 1-2: AD-001 wallet-untouched assertions, idempotency | Real test database (`DATABASE_TEST_URL`) | Confirms no LabWallet write occurs and Transaction.status is CAPTURED — mocking hides Decimal type mismatches and FK constraint errors |
+| `__tests__/handlers.test.ts` | 3: idempotency (already CAPTURED) | Real test database | Confirms early-return guard; wallet remains null |
+| `__tests__/handlers.test.ts` | 4: processPaymentCapture FAILED guard (EXPIRED-then-PAID race) | Real test database | Tests the guard that throws on FAILED transaction — same real-DB rationale |
 | `__tests__/handlers.test.ts` | 5-7: processPaymentFailed transitions, idempotency, orphan tolerance | Real test database | Same rationale as above; confirms status field writes and failureReason |
-| `__tests__/handlers-rollback.test.ts` | 8: processPaymentCapture rollback error propagation | Full Prisma mock (`vi.fn()` stubs) | Forcing `tx.labWallet.upsert` to fail on a real database requires schema changes; `$transaction` atomicity is a Prisma/PostgreSQL guarantee, so this test verifies error propagation only |
+| `__tests__/handlers-rollback.test.ts` | 8: processPaymentCapture rollback error propagation | Full Prisma mock (`vi.fn()` stubs) | Forcing `tx.transaction.update` to fail on a real database requires schema changes; `$transaction` atomicity is a Prisma/PostgreSQL guarantee, so this test verifies error propagation only |
+| `__tests__/handlers.test.ts` | 9-10: completeOrder Payout creation, no CAPTURED Transaction throws | Real test database | Confirms Payout record is created with correct fee split and that missing CAPTURED Transaction surfaces as thrown error |
 | `__tests__/handlers-rollback.test.ts` | 9: processPaymentFailed rollback | Full Prisma mock | Same rationale — forcing `tx.order.update` to fail; atomicity is a Prisma guarantee |
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/README.md
+++ b/src/features/payments/webhooks/README.md
@@ -56,7 +56,7 @@
 ## Invariants
 
-- Idempotency check (`findUnique` + status guard) is inside `$transaction` to
+- Idempotency check (`findUnique` on `Transaction.externalId` + status guard) is inside `$transaction` to
   prevent race conditions from concurrent Xendit deliveries. (ref: DL-004)

```


**CC-M-002-005** (src/features/payments/webhooks/CLAUDE.md) - implements CI-M-002-005

**Code:**

```diff
--- src/features/payments/webhooks/CLAUDE.md
+++ src/features/payments/webhooks/CLAUDE.md
@@ -7,7 +7,7 @@
 | `route.ts`    | Next.js route handler; x-callback-token verification; exhaustive PAID/EXPIRED dispatch          | Modifying webhook auth or adding new Xendit event types       |
-| `handlers.ts` | `processPaymentCapture` (PAID) — Transaction CAPTURED, Order fan-out, LabWallet credit; `processPaymentFailed` (EXPIRED) — Transaction FAILED, Order PAYMENT_FAILED, no wallet write | Modifying payment capture or failure logic |
+| `handlers.ts` | `processPaymentCapture` (PAID) — Transaction CAPTURED, Order fan-out; `processPaymentFailed` (EXPIRED) — Transaction FAILED, Order PAYMENT_FAILED, no wallet write | Modifying payment capture or failure logic |
 | `types.ts`    | `XenditInvoicePayload` — webhook request body shape                                              | Adding fields from Xendit payload or modifying type contracts |
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/CLAUDE.md
+++ b/src/features/payments/webhooks/CLAUDE.md
@@ -7,7 +7,7 @@
 | `route.ts`    | Next.js route handler; x-callback-token verification; exhaustive PAID/EXPIRED dispatch          | Modifying webhook auth or adding new Xendit event types       |
-| `handlers.ts` | `processPaymentCapture` (PAID) — Transaction CAPTURED, Order fan-out; `processPaymentFailed` (EXPIRED) — Transaction FAILED, Order PAYMENT_FAILED, no wallet write | Modifying payment capture or failure logic |
+| `handlers.ts` | `processPaymentCapture` (PAID) — Transaction CAPTURED, Order fan-out, no LabWallet write (AD-001); `processPaymentFailed` (EXPIRED) — Transaction FAILED, Order PAYMENT_FAILED | Modifying payment capture or failure logic |

```


**CC-M-002-006** (src/features/payments/CLAUDE.md)

**Documentation:**

```diff
--- a/src/features/payments/CLAUDE.md
+++ b/src/features/payments/CLAUDE.md
@@ -7,6 +7,6 @@
 | Directory    | What                                                                       | When to read                                              |
 | ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
 | `checkout/`  | Deferred-payment checkout — Xendit invoice creation and redirect           | Implementing or modifying the PAYMENT_PENDING pay flow    |
-| `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler, credits LabWallet.pendingBalance; integration tests in `webhooks/__tests__/` | Implementing or modifying webhook payment capture, lab wallet crediting, or payment capture tests |
+| `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler; no LabWallet write (AD-001); integration tests in `webhooks/__tests__/` | Implementing or modifying webhook payment capture or payment capture tests |

```


### Milestone 3: Lab fulfillment: Payout commission record on completion

**Files**: src/features/orders/lab-fulfillment/action.ts, src/features/orders/lab-fulfillment/README.md, src/features/orders/lab-fulfillment/CLAUDE.md, src/features/payments/webhooks/__tests__/handlers.test.ts

**Requirements**:

- completeOrder fetches the CAPTURED Transaction via tx.transaction.findFirst({ where: { orderId, status: TransactionStatus.CAPTURED } }) inside the existing $transaction
- completeOrder throws new Error if no CAPTURED Transaction found (Implementation Discipline)
- completeOrder computes platformFee = grossAmount.mul(COMMISSION_RATE) and netAmount = grossAmount.sub(platformFee) with Decimal arithmetic only
- completeOrder calls tx.payout.create with grossAmount, platformFee, netAmount, feePercentage (equals COMMISSION_RATE Decimal — not coerced to Number), labId, orderId, transactionId, status QUEUED
- Payout.create runs inside the same prisma.$transaction as the Order COMPLETED update
- handlers.test.ts gains a new fourth describe block exercising completeOrder end-to-end (seed CAPTURED Transaction, call completeOrder, assert Payout fields and Order COMPLETED, using isRedirectError discrimination so the redirect throw does not mask other errors)

**Acceptance Criteria**:

- npx tsc --noEmit passes
- npm test -- --run passes
- Payout.grossAmount.toFixed(2) equals Transaction.amount.toFixed(2)
- Payout.platformFee.toFixed(2) equals (gross * 0.10).toFixed(2)
- Payout.netAmount.toFixed(2) equals (gross - platformFee).toFixed(2)
- Payout.feePercentage Decimal value equals 0.1000
- Payout.status equals QUEUED
- Payout.transactionId equals the seeded CAPTURED Transaction.id
- completeOrder rejects with Error when no CAPTURED Transaction exists for the orderId

#### Code Intent

- **CI-M-003-001** `src/features/orders/lab-fulfillment/action.ts::completeOrder`: completeOrder gains two new responsibilities inside its existing prisma.$transaction callback, executed AFTER the tx.order.update that writes COMPLETED (DL-011: the existing TOCTOU re-fetch + isValidStatusTransition guard runs before the update, so by the time control reaches it the IN_PROGRESS->COMPLETED transition is known valid; placing the Payout work after the update keeps the diff minimal and preserves the canonical status-then-ledger pattern). First, it fetches the CAPTURED Transaction for the order: const capturedTransaction = await tx.transaction.findFirst({ where: { orderId, status: TransactionStatus.CAPTURED } }). If capturedTransaction is null, the action throws new Error with a message naming the orderId (Implementation Discipline; the state machine guarantees a CAPTURED Transaction exists by the time an order is IN_PROGRESS, per DL-004). Second, it computes the Decimal fee split: const grossAmount = capturedTransaction.amount (Decimal column per prisma/schema.prisma:247, DL-013 — no toNumber coercion at the boundary); const platformFee = grossAmount.mul(COMMISSION_RATE); const netAmount = grossAmount.sub(platformFee). Third, it creates the Payout: await tx.payout.create({ data: { orderId, labId: order.lab.id (DL-012: source from the already-loaded Lab relation, not the scalar order.labId), transactionId: capturedTransaction.id, grossAmount, platformFee, netAmount, feePercentage: COMMISSION_RATE (the Decimal constant — NOT a number literal, per DL-006: the Decimal(5,4) feePercentage column accepts numbers but passing the Decimal forecloses float drift), status: PayoutStatus.QUEUED } }). The function gains three imports: TransactionStatus and PayoutStatus from @prisma/client (alongside the existing OrderStatus), and COMMISSION_RATE from @/domain/payments/commission. Auth, TOCTOU guard, ownership check, isValidStatusTransition call, notes write, revalidatePath, and redirect remain in their existing positions. startProcessing is unchanged. (refs: DL-003, DL-004, DL-005, DL-006, DL-007, DL-010, DL-011, DL-012, DL-013)
- **CI-M-003-002** `src/features/payments/webhooks/__tests__/handlers.test.ts`: A new fourth describe block exercises completeOrder end-to-end against the real test database. Setup: seed an Order at IN_PROGRESS status with TEST_USER_LAB_ID as the lab owner, plus a CAPTURED Transaction with amount 1500.00 for that orderId. The test mocks @/lib/auth to return a session with userId TEST_USER_LAB_ID and role LAB_ADMIN. It invokes completeOrder with a FormData containing orderId and notes Done. Because completeOrder ends with redirect() (which throws NEXT_REDIRECT in Next.js Server Actions), the assertion uses isRedirectError discrimination so the test does not silently pass on unrelated thrown errors: try { await completeOrder(formData) } catch (err) { if (!isRedirectError(err)) throw err } — equivalently, await expect(completeOrder(formData)).rejects.toThrow(/NEXT_REDIRECT/) — but the explicit isRedirectError import from next/dist/client/components/redirect is preferred because it is the public contract for redirect detection and survives Next.js internal-error message changes. After the redirect throw is filtered, the test queries the DB: testPrisma.order.findUnique returns status COMPLETED and notes Done; testPrisma.payout.findFirst({ where: { orderId } }) returns a row with grossAmount.toFixed(2) === 1500.00, platformFee.toFixed(2) === 150.00, netAmount.toFixed(2) === 1350.00, feePercentage Decimal value 0.1000, status QUEUED, transactionId equal to the seeded CAPTURED Transaction.id. A second test in the same describe block asserts completeOrder rejects with an Error matching /CAPTURED Transaction/ when no CAPTURED Transaction exists for the order (seed only the Order at IN_PROGRESS without a Transaction); this test MUST use a message-matching assertion (expect(...).rejects.toThrow(/CAPTURED Transaction/)) so the missing-Transaction throw is distinguished from the NEXT_REDIRECT throw and from any unrelated Prisma or auth error. The cleanup helper grows: testPrisma.payout.deleteMany is added before the existing labWallet/transaction/order deletions to satisfy FK constraints. (refs: DL-003, DL-004)
- **CI-M-003-003** `src/features/orders/lab-fulfillment/README.md`: The Architecture section completeOrder block gains two bullets after isValidStatusTransition(IN_PROGRESS, COMPLETED): one labeled tx.transaction.findFirst({ orderId, status: CAPTURED }) — throws if absent and one labeled tx.payout.create({ ...gross/fee/net... }) — commission record (DL-NEW). A new Design Decisions entry titled Payout commission record created inside completeOrder $transaction (DL-NEW) explains: AD-001 Direct Payment splits commission at Xendit settlement; the Payout record captures the confirmed commission at order completion (PipetGo's side of the ledger). All fee math is Decimal; the gross is taken from the CAPTURED Transaction.amount, not Order.quotedPrice, so the commission is computed on the amount actually captured. Payout.status starts at QUEUED; T-10 (settlement webhook) transitions it to COMPLETED. The Invariants section gains a bullet: every Order transitioning to COMPLETED must produce exactly one Payout in QUEUED state inside the same $transaction; no CAPTURED Transaction means the contract is violated and the action throws. (refs: DL-003, DL-004, DL-007)
- **CI-M-003-004** `src/features/orders/lab-fulfillment/CLAUDE.md`: The action.ts row When to read column gains commission Payout creation. The action.ts row Contents column expands to mention completeOrder creates a Payout commission record (status QUEUED) inside the same $transaction. The page.tsx and ui.tsx rows are unchanged. (refs: DL-003)

#### Code Changes

**CC-M-003-001** (src/features/orders/lab-fulfillment/action.ts) - implements CI-M-003-001

**Code:**

```diff
--- src/features/orders/lab-fulfillment/action.ts
+++ src/features/orders/lab-fulfillment/action.ts
@@ -20,7 +20,7 @@
 import { revalidatePath } from 'next/cache'
 import { redirect } from 'next/navigation'
-import { OrderStatus } from '@prisma/client'
+import { OrderStatus, TransactionStatus, PayoutStatus } from '@prisma/client'
 import { prisma } from '@/lib/prisma'
 import { auth } from '@/lib/auth'
 import { isValidStatusTransition } from '@/domain/orders/state-machine'
+import { COMMISSION_RATE } from '@/domain/payments/commission'
 
@@ -78,6 +78,7 @@
  * Transitions an IN_PROGRESS order to COMPLETED and writes the lab
  * technician's result notes to Order.notes. The re-fetch, ownership check,
- * and status write are wrapped in a single $transaction for an atomic
- * read-check-write, eliminating the TOCTOU race window. Redirects to
- * /dashboard/lab on success. (ref: DL-006, DL-007)
+ * status write, and Payout commission record creation are wrapped in a single
+ * $transaction for an atomic read-check-write, eliminating the TOCTOU race
+ * window. Creates a QUEUED Payout for the commission on completion.
+ * Redirects to /dashboard/lab on success. (ref: DL-006, DL-007)
  */
@@ -95,7 +95,7 @@
   const result = await prisma.$transaction(async (tx) => {
     const order = await tx.order.findUnique({
       where: { id: orderId },
-      include: { lab: true },
+      include: { lab: true },
     })
 
     if (!order || !order.lab || order.lab.ownerId !== session.user.id) {
@@ -108,10 +108,27 @@
     await tx.order.update({
       where: { id: orderId },
       data: {
         status: OrderStatus.COMPLETED,
         ...(notes != null ? { notes } : {}),
       },
     })
 
+    const capturedTransaction = await tx.transaction.findFirst({
+      where: { orderId, status: TransactionStatus.CAPTURED },
+    })
+
+    if (!capturedTransaction) {
+      throw new Error(`No CAPTURED Transaction found for orderId ${orderId} during Payout creation`)
+    }
+
+    const grossAmount = capturedTransaction.amount
+    const platformFee = grossAmount.mul(COMMISSION_RATE)
+    const netAmount = grossAmount.sub(platformFee)
+
+    await tx.payout.create({
+      data: {
+        orderId,
+        labId: order.lab.id,
+        transactionId: capturedTransaction.id,
+        grossAmount,
+        platformFee,
+        netAmount,
+        feePercentage: COMMISSION_RATE,
+        status: PayoutStatus.QUEUED,
+      },
+    })
+
     return null
   })
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/action.ts
+++ b/src/features/orders/lab-fulfillment/action.ts
@@ -78,10 +78,10 @@
 /**
  * Transitions an IN_PROGRESS order to COMPLETED and writes the lab
  * technician's result notes to Order.notes. The re-fetch, ownership check,
- * status write, and Payout commission record creation are wrapped in a single
- * $transaction for an atomic read-check-write, eliminating the TOCTOU race
- * window. Creates a QUEUED Payout for the commission on completion.
- * Redirects to /dashboard/lab on success. (ref: DL-006, DL-007)
+ * status write, and Payout creation are wrapped in a single $transaction for
+ * an atomic read-check-write, eliminating the TOCTOU race window. (ref: DL-003, DL-015)
+ * Creates a QUEUED Payout recording commission confirmed at order completion.
+ * Redirects to /dashboard/lab on success. (ref: DL-006, DL-007)
  */
@@ -108,17 +108,27 @@
     await tx.order.update({
       where: { id: orderId },
       data: {
         status: OrderStatus.COMPLETED,
         ...(notes != null ? { notes } : {}),
       },
     })
 
+    // Order.update precedes the Payout write: the TOCTOU guard above has already
+    // validated IN_PROGRESS -> COMPLETED; status write first preserves the
+    // established action.ts pattern (status write, then ledger writes). (ref: DL-011)
+
+    // findFirst because Transaction has no @unique on (orderId, status) — it is
+    // an @@index only. At COMPLETED time exactly one CAPTURED row exists per orderId
+    // (capture is idempotent; retries write new PENDING rows, not new CAPTURED). (ref: DL-004)
     const capturedTransaction = await tx.transaction.findFirst({
       where: { orderId, status: TransactionStatus.CAPTURED },
     })
 
     if (!capturedTransaction) {
+      // Absence is a contract violation per Implementation Discipline — throw, never default. (ref: DL-004)
       throw new Error(`No CAPTURED Transaction found for orderId ${orderId} during Payout creation`)
     }
 
+    // All arithmetic on Prisma Decimal instances — no Number coercion at any step.
+    // capturedTransaction.amount is Decimal(12,2) per schema.prisma:247. (ref: DL-006, DL-013)
     const grossAmount = capturedTransaction.amount
     const platformFee = grossAmount.mul(COMMISSION_RATE)
     const netAmount = grossAmount.sub(platformFee)
 
     await tx.payout.create({
       data: {
         orderId,
-        labId: order.lab.id,
+        labId: order.lab.id, // relation object already in memory from ownership check (ref: DL-012)
         transactionId: capturedTransaction.id,
         grossAmount,
         platformFee,
         netAmount,
         feePercentage: COMMISSION_RATE,
-        status: PayoutStatus.QUEUED,
+        status: PayoutStatus.QUEUED, // T-10 (settlement webhook) owns QUEUED -> COMPLETED. (ref: DL-007)
       },
     })
 
     return null
   })

```


**CC-M-003-002** (src/features/payments/webhooks/__tests__/handlers.test.ts) - implements CI-M-003-002

**Code:**

```diff
--- src/features/payments/webhooks/__tests__/handlers.test.ts
+++ src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -1,5 +1,5 @@
 import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
-import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode } from '@prisma/client'
+import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode, PayoutStatus } from '@prisma/client'
 import { testPrisma } from '@/test/test-prisma'
 import { processPaymentCapture, processPaymentFailed } from '../handlers'
+import { completeOrder } from '@/features/orders/lab-fulfillment/action'
+import { isRedirectError } from 'next/dist/client/components/redirect'
 import type { XenditInvoicePayload } from '../types'
@@ -6,6 +9,15 @@
 vi.mock('@/lib/prisma', async () => {
   const { testPrisma: client } = await import('@/test/test-prisma')
   return { prisma: client }
 })
+
+vi.mock('@/lib/auth', () => ({
+  auth: vi.fn().mockResolvedValue({
+    user: { id: 'test-user-lab-1', role: 'LAB_ADMIN' },
+  }),
+}))
+vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
+vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
+
 const TEST_USER_CLIENT_ID = 'test-user-client-1'
@@ -23,10 +35,11 @@
 async function cleanup() {
+  await testPrisma.payout.deleteMany({ where: { orderId: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } } })
   await testPrisma.labWallet.deleteMany({ where: { labId: TEST_LAB_ID } })
   await testPrisma.transaction.deleteMany({
     where: {
       externalId: {
         in: [TEST_TX_EXTERNAL_ID_1, TEST_TX_EXTERNAL_ID_2, TEST_TX_EXTERNAL_ID_3, TEST_TX_EXTERNAL_ID_4],
       },
     },
   })
   await testPrisma.order.deleteMany({
     where: { id: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } },
   })
@@ -221,3 +234,66 @@
   })
 })
+
+describe('completeOrder — Payout commission record creation', () => {
+  const TEST_TX_INTERNAL_ID = 'test-tx-internal-payout'
+
+  it('creates a QUEUED Payout with correct fee split when completeOrder is called on an IN_PROGRESS order', async () => {
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
+        id: TEST_TX_INTERNAL_ID,
+        orderId: TEST_ORDER_ID_1,
+        externalId: TEST_TX_EXTERNAL_ID_1,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.CAPTURED,
+      },
+    })
+
+    const formData = new FormData()
+    formData.set('orderId', TEST_ORDER_ID_1)
+    formData.set('notes', 'Done')
+
+    try {
+      await completeOrder(null, formData)
+    } catch (err) {
+      if (!isRedirectError(err)) throw err
+    }
+
+    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_1 } })
+    expect(order!.status).toBe(OrderStatus.COMPLETED)
+    expect(order!.notes).toBe('Done')
+
+    const payout = await testPrisma.payout.findFirst({ where: { orderId: TEST_ORDER_ID_1 } })
+    expect(payout).not.toBeNull()
+    expect(payout!.grossAmount.toFixed(2)).toBe('1500.00')
+    expect(payout!.platformFee.toFixed(2)).toBe('150.00')
+    expect(payout!.netAmount.toFixed(2)).toBe('1350.00')
+    expect(payout!.feePercentage.toFixed(4)).toBe('0.1000')
+    expect(payout!.status).toBe(PayoutStatus.QUEUED)
+    expect(payout!.transactionId).toBe(TEST_TX_INTERNAL_ID)
+  })
+
+  it('throws when no CAPTURED Transaction exists for the order', async () => {
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
+
+    const formData = new FormData()
+    formData.set('orderId', TEST_ORDER_ID_2)
+
+    await expect(completeOrder(null, formData)).rejects.toThrow(/CAPTURED Transaction/)
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -234,4 +234,5 @@
 
+// Payout creation tests live here (not lab-fulfillment/__tests__) to share the real-DB setup and cleanup with webhook capture tests. (ref: DL-003)
 describe('completeOrder — Payout commission record creation', () => {

```


**CC-M-003-003** (src/features/orders/lab-fulfillment/README.md) - implements CI-M-003-003

**Code:**

```diff
--- src/features/orders/lab-fulfillment/README.md
+++ src/features/orders/lab-fulfillment/README.md
@@ -38,6 +38,8 @@
   completeOrder:
     -> TOCTOU re-fetch: re-verify ownership + status (DL-007)
     -> isValidStatusTransition(IN_PROGRESS, COMPLETED)
     -> prisma.order.update status = COMPLETED, notes = formData.notes (DL-003)
+    -> tx.transaction.findFirst({ orderId, status: CAPTURED }) — throws if absent
+    -> tx.payout.create({ ...gross/fee/net... }) — commission record (DL-NEW)
     -> revalidatePath then redirect('/dashboard/lab') (DL-006)
@@ -88,4 +90,14 @@
 - Both server actions re-fetch the order to guard against TOCTOU races.
+
+**Payout commission record created inside completeOrder $transaction (DL-NEW)**: Under
+AD-001 Direct Payment, Xendit automatically splits PipetGo commission at settlement;
+the Payout record captures the confirmed commission at order completion (PipetGo's side
+of the ledger). All fee arithmetic uses Decimal; the gross is taken from the CAPTURED
+Transaction.amount, not Order.quotedPrice, so the commission is computed on the amount
+actually captured. Payout.status starts at QUEUED; T-10 (settlement webhook) transitions
+it to COMPLETED.
+
+**Invariant**: every Order transitioning to COMPLETED must produce exactly one Payout in
+QUEUED state inside the same $transaction. No CAPTURED Transaction found means the
+contract is violated and the action throws.
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/README.md
+++ b/src/features/orders/lab-fulfillment/README.md
@@ -38,8 +38,8 @@
   completeOrder:
     -> TOCTOU re-fetch: re-verify ownership + status (DL-007)
     -> isValidStatusTransition(IN_PROGRESS, COMPLETED)
-    -> prisma.order.update status = COMPLETED, notes = formData.notes (DL-003)
-    -> tx.transaction.findFirst({ orderId, status: CAPTURED }) — throws if absent
-    -> tx.payout.create({ ...gross/fee/net... }) — commission record (DL-NEW)
+    -> tx.order.update status = COMPLETED, notes = formData.notes (DL-003, DL-011)
+    -> tx.transaction.findFirst({ orderId, status: CAPTURED }) — throws if none (DL-004)
+    -> tx.payout.create({ grossAmount, platformFee, netAmount, feePercentage, QUEUED }) — commission record (DL-003, DL-007)
     -> revalidatePath then redirect('/dashboard/lab') (DL-006)
@@ -90,14 +90,22 @@
 - Both server actions re-fetch the order to guard against TOCTOU races.
 
-**Payout commission record created inside completeOrder $transaction (DL-NEW)**: Under
-AD-001 Direct Payment, Xendit automatically splits PipetGo commission at settlement;
-the Payout record captures the confirmed commission at order completion (PipetGo's side
-of the ledger). All fee arithmetic uses Decimal; the gross is taken from the CAPTURED
-Transaction.amount, not Order.quotedPrice, so the commission is computed on the amount
-actually captured. Payout.status starts at QUEUED; T-10 (settlement webhook) transitions
-it to COMPLETED.
+**Payout commission record created inside completeOrder $transaction (DL-003)**: Under
+AD-001 Direct Payment, Xendit automatically splits PipetGo commission at settlement;
+the Payout record captures confirmed commission at order completion — PipetGo's side
+of the ledger. All fee arithmetic uses Decimal (DL-006); gross comes from
+`Transaction.amount` (Decimal(12,2), schema.prisma:247), not `Order.quotedPrice`, so
+commission is computed on the amount actually captured. `Payout.status` starts at
+`QUEUED`; T-10 (settlement webhook) owns the `QUEUED → COMPLETED` transition (DL-007).
 
-**Invariant**: every Order transitioning to COMPLETED must produce exactly one Payout in
-QUEUED state inside the same $transaction. No CAPTURED Transaction found means the
-contract is violated and the action throws.
+**Invariant — one Payout per COMPLETED order (DL-003)**: every Order transitioning to
+`COMPLETED` produces exactly one `Payout` in `QUEUED` state inside the same
+`$transaction`. Absence of a `CAPTURED` Transaction means the contract is violated;
+the action throws (`new Error`) per Implementation Discipline rather than silently
+defaulting. Double-execution is prevented by the existing TOCTOU guard: a second
+invocation finds `Order.status === COMPLETED` on the re-fetch and throws before
+reaching `tx.payout.create` (DL-015).
+
+**No backfill for pre-T-09 COMPLETED orders (DL-014)**: production has zero historical
+COMPLETED orders before T-09 ships. T-10 implementors can assume every COMPLETED order
+from T-09 onward has exactly one QUEUED Payout.
+
+**handlePaymentCaptured must NOT create Payout (DL-016)**: a Payout at capture time
+is premature — the lab may issue a refund or the order may not reach COMPLETED.
+Payout creation is exclusive to completeOrder.
+
+**Slice boundary: Payout write is schema-level, not cross-slice (DL-010)**: `completeOrder`
+gains one ledger write (`tx.payout.create`) but does not import from `@/features/payments/*`.
+`Payout` is a Prisma model owned by the schema, not a feature slice; writing it via `tx`
+is a schema-level operation. The only added import is `COMMISSION_RATE` from
+`@/domain/payments/commission` — kernel-level, allowed under ADR-001. ADR-001 reviewers:
+the lab-fulfillment slice has no cross-slice import violation from this change.

```


**CC-M-003-004** (src/features/orders/lab-fulfillment/CLAUDE.md) - implements CI-M-003-004

**Code:**

```diff
--- src/features/orders/lab-fulfillment/CLAUDE.md
+++ src/features/orders/lab-fulfillment/CLAUDE.md
@@ -7,6 +7,6 @@
 | File        | What                                                                                              | When to read                                                       |
 | ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
 | `page.tsx`  | Async RSC — LAB_ADMIN auth, ownership guard, status guard, Decimal->string DTO, renders UI       | Modifying auth gate, order fetch, ownership check, or `LabOrderDTO` |
-| `action.ts` | Two server actions — `startProcessing` (ACKNOWLEDGED->IN_PROGRESS) and `completeOrder` (IN_PROGRESS->COMPLETED); TOCTOU guards | Modifying transitions, notes write, or revalidation |
+| `action.ts` | Two server actions — `startProcessing` (ACKNOWLEDGED->IN_PROGRESS) and `completeOrder` (IN_PROGRESS->COMPLETED); TOCTOU guards; `completeOrder` creates a Payout commission record (status QUEUED) inside the same `$transaction` | Modifying transitions, notes write, revalidation, or commission Payout creation |
 | `ui.tsx`    | `'use client'` — conditional rendering per status; `StartProcessingForm` and `CompleteOrderForm` with `useActionState` | Modifying form layout, error display, or notes textarea |
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/CLAUDE.md
+++ b/src/features/orders/lab-fulfillment/CLAUDE.md
@@ -10,6 +10,6 @@
 | `page.tsx`  | Async RSC — LAB_ADMIN auth, ownership guard, status guard, Decimal->string DTO, renders UI       | Modifying auth gate, order fetch, ownership check, or `LabOrderDTO` |
-| `action.ts` | Two server actions — `startProcessing` (ACKNOWLEDGED->IN_PROGRESS) and `completeOrder` (IN_PROGRESS->COMPLETED); TOCTOU guards; `completeOrder` creates a Payout commission record (status QUEUED) inside the same `$transaction` | Modifying transitions, notes write, revalidation, or commission Payout creation |
+| `action.ts` | Two server actions — `startProcessing` (ACKNOWLEDGED->IN_PROGRESS) and `completeOrder` (IN_PROGRESS->COMPLETED, writes QUEUED Payout); TOCTOU guards on both | Modifying transitions, notes write, revalidation, or Payout creation |
 | `ui.tsx`    | `'use client'` — conditional rendering per status; `StartProcessingForm` and `CompleteOrderForm` with `useActionState` | Modifying form layout, error display, or notes textarea |

```

