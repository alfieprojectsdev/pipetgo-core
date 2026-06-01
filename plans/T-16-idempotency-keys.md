# Plan

## Overview

Webhook dedup currently relies on entity-state guards: processPaymentCapture and processPaymentFailed early-return on Transaction.status terminal values; processSettlement early-returns on Payout.externalPayoutId @unique + Payout.status===COMPLETED. These guards work for events whose business entity already exists, but provide no protection at the broadest layer (before any lookup) and cannot extend to providers or event types that do not yet have a business entity in our schema. T-17 (PESONet) and any future refund webhook will need dedup before any entity lookup is possible.

**Approach**: Add a formal IdempotencyKey table (key String @unique, processedAt DateTime @default(now()), no TTL) and check it as the first step inside each handler's existing $transaction, with key creation as the last step before commit. Key format encodes provider:product:event:externalId (xendit:invoice:PAID:{externalId}, xendit:invoice:EXPIRED:{externalId}, xendit:settlement:COMPLETED:{settlementId}). The check is placed at the top of the existing $transaction blocks; the create is placed after all business writes succeed so the entire flow is atomic — Xendit retries on a mid-handler error find no key and re-attempt cleanly. The existing Transaction.status, Payout.status, and Payout.externalPayoutId guards are kept unchanged: they encode state-machine invariants (R-007 EXPIRED-then-PAID throws, PROCESSING/FAILED contract-violation throws) and concurrent-first-delivery compare-and-set semantics (Payout.updateMany count===0 short-circuit) that are independent of dedup.

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Add IdempotencyKey table with key @unique, processedAt @default(now()), no TTL | Existing dedup uses Transaction.status===CAPTURED and Payout.externalPayoutId @unique — both work but only for events whose business entity already exists; a future webhook (T-17 PESONet, refund) needs dedup before any business row is queried -> a dedicated key row scoped by provider+product+event+externalId catches the duplicate before the handler does any work -> no TTL because volume at MVP scale (low single-digit webhooks/day) yields negligible row growth and adding TTL drags in cron infrastructure that is not justified -> append-only design is the simplest correct primitive that future tickets can extend |
| DL-002 | Key check is the FIRST step inside the existing $transaction; key creation is the LAST step before the $transaction commits | Placing the @unique violation at commit time (after business writes) is what closes the concurrent-delivery race — two simultaneous deliveries both pass the empty findUnique check, both perform business writes, only one of the IdempotencyKey.create calls wins, the other commit fails and rolls back the duplicate business writes -> placing create BEFORE the writes would block the retry path: a transient DB error mid-handler would leave the key persisted with the work undone and Xendit retries would skip it -> create at the end keeps create-success and business-write-success atomically tied together via the same $transaction |
| DL-003 | Key format encodes provider:product:event:externalId — e.g. xendit:invoice:PAID:{invoiceId}, xendit:invoice:EXPIRED:{invoiceId}, xendit:settlement:COMPLETED:{settlementId} | PAID and EXPIRED for the same Xendit invoice ID are semantically distinct events with different writes (CAPTURED vs FAILED) -> a key keyed only on externalId would collapse them and let an EXPIRED delivery dedup against an earlier PAID delivery -> embedding the event type in the key string preserves per-event dedup; the colon separator is the standard convention; including the provider segment makes T-17 PESONet keys non-overlapping in advance without a schema migration |
| DL-004 | Keep Transaction.status guard, Payout.status guard, and Payout.externalPayoutId guard as supplementary layers — IdempotencyKey supplements, never replaces | Transaction.status===CAPTURED enforces the state-machine invariant that CAPTURED is terminal — independent of dedup, it is what allows R-007 (PAID-for-FAILED transaction) to throw rather than silently overwrite; Payout PROCESSING/FAILED throws are contract-violation guards (Implementation Discipline) and are not dedup; the externalPayoutId @unique on Payout participates in the concurrent-first-delivery compare-and-set (updateMany with externalPayoutId:null guard, count===0 short-circuit) -> removing any of these to claim IdempotencyKey now owns dedup would lose the state-machine invariants and the compare-and-set semantics -> layered defense; IdempotencyKey is the broad first-cut and the status/CAS guards remain the precise second-cut |
| DL-005 | Use findUnique + create (two calls) — not upsert — for IdempotencyKey access inside the transaction | upsert returns the resulting row without an explicit signal of whether the row pre-existed (would need an additional select or transactional read to distinguish) -> findUnique gives an unambiguous null vs row result that maps directly to the early-return branch; create then enforces the @unique constraint at commit time, which is the exact behaviour required to close the concurrent-delivery race -> matches Implementation Discipline findUnique-on-@unique rule and mirrors the existing webhook handler pattern (processPaymentCapture findUnique by externalId) |
| DL-006 | processSettlement key check runs BEFORE the existing dual-lookup (findUnique externalPayoutId, then findFirst orderId+QUEUED+null) | The dual-lookup design exists because externalPayoutId is null until first delivery — there is no single column to lookup by until after the first settlement writes it -> the IdempotencyKey check by xendit:settlement:COMPLETED:{payload.id} works on every delivery because payload.id is provided by Xendit on every call -> putting the key check first means a duplicate delivery exits at the broadest layer before either Payout lookup runs, simplifying the duplicate path |
| DL-007 | Failed deliveries (handler throws, $transaction rolls back) MUST also roll back the IdempotencyKey row — achieved automatically by placing create inside the same $transaction | Xendit retries on 5xx; if a handler throws after key creation outside the transaction, the retry would see the persisted key and silently skip the work that never completed -> persisting the key only on successful commit means Xendit retries land on an empty key lookup and re-attempt the work cleanly -> $transaction atomicity already provides this property at no extra cost |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Replace existing Transaction.status / Payout.externalPayoutId / Payout.status guards with IdempotencyKey only | The status guards encode state-machine invariants and contract-violation throws (R-007 EXPIRED-then-PAID throw; Payout PROCESSING/FAILED throw) that are independent of dedup. Removing them would let a CAPTURED transaction be re-processed under a key miss and would silently drop the unhandled-enum-branch protection from PayoutStatus. Layered defense is the safer design. (ref: DL-004) |
| Add a TTL column on IdempotencyKey and a cron job to expire old rows | At MVP webhook volume (low single-digit deliveries per day) the table will not grow to a problematic size within the MVP window. Adding TTL drags in cron-infrastructure complexity and a migration path for expired-then-redelivered edge cases with no current benefit. Append-only is the simplest correct primitive; TTL can be added later under a separate ticket if volume justifies it. (ref: DL-001) |
| Use Prisma upsert for the IdempotencyKey row in a single call | upsert returns the resulting row without an explicit signal of whether it pre-existed (caller would need an extra read to distinguish). findUnique + create gives an unambiguous null vs row branch that maps directly to the early-return; the create then enforces the @unique constraint at commit time, which is the exact behaviour required to close the concurrent-delivery race. Matches Implementation Discipline findUnique-on-@unique rule and the existing handler patterns. (ref: DL-005) |
| Key keyed only on the externalId (e.g. just xendit-{invoice_id}) | PAID and EXPIRED for the same Xendit invoice ID are semantically distinct events with different writes. A key keyed only on externalId would collide between the PAID and EXPIRED deliveries, causing the second event type to dedup against the first. Embedding the event type in the key segment preserves per-event dedup. (ref: DL-003) |
| Create the IdempotencyKey row BEFORE the business writes (early-create pattern) | A transient DB error during the business writes would leave the key persisted with the work undone; Xendit retries would see the key and skip, leaving the transaction permanently un-completed. Placing the create at the end of the $transaction means key persistence is atomically tied to business-write success: a throw rolls back both, allowing retries to land cleanly. (See also DL-007.) (ref: DL-002) |

### Constraints

- MUST: IdempotencyKey check and business-write are inside the same $transaction (atomicity — prevents race between check and write)
- MUST: supplement existing status-based guards, not replace — status guards encode state-machine invariants independent of dedup
- MUST: existing payment capture, payment failure, and settlement integration tests pass unchanged
- MUST: key format encodes provider + product + event type + externalId — e.g. xendit:invoice:PAID:{externalId}
- MUST: duplicate delivery returns 200 (early return inside handler, route returns 200 as normal)
- MUST: findUnique on IdempotencyKey.key (@unique) per Implementation Discipline; NOT findFirst
- MUST NOT: add TTL column — append-only at current scale
- SHOULD: Prisma migration runs against test DB and production DB without manual intervention (consistent with other migrations in the project)

### Known Risks

- **Two simultaneous Xendit deliveries for the same event both pass the empty findUnique key check, both perform business writes, both attempt IdempotencyKey.create — only one wins, the other's $transaction throws on @unique violation and rolls back, Xendit retries the loser and the retry sees the key and short-circuits cleanly. Risk depends on Prisma surfacing the unique violation as a thrown error that aborts the $transaction.**: Prisma surfaces unique-constraint violations as P2002 PrismaClientKnownRequestError which propagates out of $transaction and triggers rollback; the route handler returns 500 and Xendit retries. New rollback test in handlers-rollback.test.ts (CI-M-001-008) confirms create-rejection propagates as a thrown error.
- **IdempotencyKey table grows unbounded without TTL**: MVP webhook volume is low single-digit deliveries per day; even a year of growth fits in a few hundred KB. A future TTL/expiry ticket can prune by processedAt if volume justifies it. The processedAt column is in place for that future query.
- **Key format drift between handlers — e.g. one handler writes xendit:invoice:PAID:{id} and another writes xendit_invoice_PAID_{id} — would silently break dedup if the same handler is later refactored**: Key strings are inlined at the only place each event type is produced (one per handler); separator and segment order are documented in src/features/payments/webhooks/README.md and src/features/payments/payouts/README.md (CI-M-001-009, CI-M-001-010). A future refactor that extracts a key-builder helper is out of scope for T-16; if T-17 adds a third provider, a helper can be introduced under that ticket.

## Invisible Knowledge

### System

Webhook dedup in this codebase is layered, not single-source. The IdempotencyKey table is the broadest first-cut layer (provider-agnostic, schema-only, no entity required). Layer 2 is entity-state: Transaction.status===CAPTURED for invoice PAID dedup; Transaction.status===FAILED for EXPIRED dedup; Payout.status===COMPLETED + Payout.externalPayoutId @unique for settlement dedup. Layer 3 is concurrent-first-delivery compare-and-set: Payout.updateMany with {id, externalPayoutId:null} guard + count===0 short-circuit (settlement handler). Each layer protects a different concurrency window: IdempotencyKey closes the broadest window before any lookup; status guards close the post-lookup window for cleanly-spaced retries; updateMany CAS closes the simultaneous-first-delivery window. Removing any one layer creates a slice of unprotected behaviour.

### Invariants

- IdempotencyKey.key is @unique — duplicate creates inside a $transaction throw P2002 at commit time, causing $transaction rollback. This is the mechanism that closes the simultaneous-delivery race; findUnique alone (without create-at-end) would be insufficient
- IdempotencyKey.create participates in the same $transaction as the business writes — a handler throw rolls back both the key and the writes, allowing Xendit retries to land cleanly
- Key format provider:product:event:externalId — PAID and EXPIRED for the same invoice ID are separate keys (xendit:invoice:PAID:{id} vs xendit:invoice:EXPIRED:{id}); collision-by-omission of the event segment would let one event type silently dedup against another
- IdempotencyKey check is the FIRST step inside $transaction; create is the LAST step before commit — order matters because early-create breaks the retry path on transient mid-handler errors
- Status-based guards (Transaction.status, Payout.status, Payout.externalPayoutId) remain in place — IdempotencyKey supplements, never replaces; status guards encode state-machine invariants and contract-violation throws that are independent of dedup
- processSettlement places the IdempotencyKey.create AFTER the Payout.updateMany count===0 short-circuit — concurrent-first-delivery losers (which return early via count===0) do not persist a key; only the winning delivery does

### Tradeoffs

- Append-only IdempotencyKey table (no TTL) vs TTL+cron: append-only is correct at MVP scale and avoids dragging in cron infrastructure; row growth is negligible at current webhook volume. TTL can be added later under a separate ticket if volume justifies it — the processedAt column is already in place for that future query
- findUnique + create (two calls) vs upsert (one call): upsert is one round-trip cheaper but does not signal pre-existence without an extra read. findUnique+create gives an unambiguous null-vs-row branch that maps directly to the early-return path; matches Implementation Discipline and existing handler patterns
- Inlined key strings per handler vs extracted key-builder helper: at T-16 with two providers and three event types, inlined strings are clearer and the format is documented in slice READMEs. Extracting a helper now would be premature abstraction; T-17 (PESONet) is the natural point to introduce a helper if a third provider lands
- Schema-only model (no FK to Transaction or Payout) vs FK-tied keys: the table is provider-agnostic and event-agnostic by design so it can dedup events that have no business entity yet (future refund webhooks, T-17 PESONet payment notifications). A FK would couple the dedup layer to the specific business entity and lose that property

## Milestones

### Milestone 1: IdempotencyKey schema + handler wiring + tests

**Files**: prisma/schema.prisma, prisma/migrations/20260519120000_add_idempotency_keys/migration.sql, src/features/payments/webhooks/handlers.ts, src/features/payments/webhooks/__tests__/handlers.test.ts, src/features/payments/payouts/handlers.ts, src/features/payments/payouts/__tests__/handlers.test.ts, src/features/payments/payouts/__tests__/handlers-rollback.test.ts, src/features/payments/CLAUDE.md, src/features/payments/webhooks/README.md, src/features/payments/payouts/README.md

**Flags**: schema-migration, webhook-dedup

**Requirements**:

- Add IdempotencyKey model to schema.prisma|Generate Prisma migration creating idempotency_keys table with key TEXT UNIQUE NOT NULL and processed_at TIMESTAMPTZ DEFAULT NOW()|processPaymentCapture checks IdempotencyKey first
- creates key on success — all inside existing $transaction|processPaymentFailed checks IdempotencyKey first
- creates key on success — all inside existing $transaction|processSettlement checks IdempotencyKey first
- creates key on success — all inside existing $transaction|Key format xendit:invoice:PAID:{externalId}
- xendit:invoice:EXPIRED:{externalId}
- xendit:settlement:COMPLETED:{payload.id}|Existing Transaction.status
- Payout.externalPayoutId
- and Payout.status guards remain unchanged — supplement only|All existing webhook and settlement integration tests pass without modification|New integration tests cover duplicate-delivery key short-circuit for capture
- failure
- and settlement paths

**Acceptance Criteria**:

- AC-001: Prisma migration creates idempotency_keys table with key UNIQUE and processed_at NOT NULL DEFAULT NOW(); npx prisma generate succeeds.
- AC-002: Duplicate delivery of a PAID webhook (same externalId; IdempotencyKey row already exists with key xendit:invoice:PAID:{externalId}) returns 200 with no Transaction.status mutation AND no duplicate IdempotencyKey row created (verified by integration test; @unique constraint enforced).
- AC-003: Duplicate delivery of an EXPIRED webhook (same externalId; IdempotencyKey row already exists with key xendit:invoice:EXPIRED:{externalId}) returns 200 with no Transaction.status mutation AND no duplicate IdempotencyKey row created (verified by integration test; @unique constraint enforced).
- AC-004: Duplicate delivery of a settlement COMPLETED webhook (same payload.id; IdempotencyKey row already exists with key xendit:settlement:COMPLETED:{payload.id}) returns 200 with no Payout.status mutation; no LabWallet balance move; and no duplicate IdempotencyKey row created (verified by integration test).
- AC-005: Cross-event-type non-collision — a pre-existing IdempotencyKey with key xendit:invoice:PAID:{externalId} does NOT short-circuit a subsequent processPaymentFailed call for the same externalId; the EXPIRED path runs normally (Transaction.status -> FAILED; Order.status -> PAYMENT_FAILED) and creates its own IdempotencyKey with key xendit:invoice:EXPIRED:{externalId} (verified by integration test).
- AC-006: First delivery of each event creates exactly one IdempotencyKey row inside the same $transaction as the business writes; if the handler throws mid-transaction no IdempotencyKey row persists (verified by rollback integration test).
- AC-007: All pre-existing tests in src/features/payments/webhooks/__tests__/handlers.test.ts and src/features/payments/payouts/__tests__/handlers.test.ts pass unchanged.
- AC-008: npx tsc --noEmit clean; npx eslint src/ clean; npm test -- --run all green.
- AC-009: PR description documents the key composition format (provider:product:event:externalId) and the supplement-not-replace relationship to existing status guards.

**Tests**:

- integration

#### Code Intent

- **CI-M-001-001** `prisma/schema.prisma`: Add IdempotencyKey model immediately after the LabWallet block (end of file): id String @id @default(cuid()); key String @unique; processedAt DateTime @default(now()); @@map("idempotency_keys"). No FK relations, no relations block. Comment above the model explains: provider-agnostic dedup row; key format provider:product:event:externalId; processedAt is informational (no TTL). No edits to existing models. No additional indexes — @unique on key is the only access path. (refs: DL-001, DL-003)
- **CI-M-001-002** `prisma/migrations/20260519120000_add_idempotency_keys/migration.sql`: Forward-only SQL migration: CREATE TABLE "idempotency_keys" ("id" TEXT NOT NULL, "key" TEXT NOT NULL, "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")); CREATE UNIQUE INDEX "idempotency_keys_key_key" ON "idempotency_keys"("key"); — matches prisma migrate dev output for the schema model in CI-M-001-001. Migration name 20260519120000 follows the existing 20260315065128 numeric convention. (refs: DL-001)
- **CI-M-001-003** `src/features/payments/webhooks/handlers.ts::processPaymentCapture`: Inside the existing prisma.$transaction block, BEFORE the tx.transaction.findUnique call, add: const idempotencyKey = `xendit:invoice:PAID:${payload.id}`; const existing = await tx.idempotencyKey.findUnique({where: {key: idempotencyKey}}); if (existing) { console.info(`[processPaymentCapture] dedup key hit key=${idempotencyKey}`); return; }. AFTER the existing handlePaymentCaptured(event, tx) call, add: await tx.idempotencyKey.create({data: {key: idempotencyKey}}); so the key is persisted only on successful completion. The existing Transaction.status guards (orphan return, CAPTURED early return, FAILED R-007 throw) remain unchanged — IdempotencyKey supplements, not replaces. findUnique on @unique field per Implementation Discipline. (refs: DL-002, DL-003, DL-004, DL-005, DL-007)
- **CI-M-001-004** `src/features/payments/webhooks/handlers.ts::processPaymentFailed`: Inside the existing prisma.$transaction block, BEFORE the tx.transaction.findUnique call, add: const idempotencyKey = `xendit:invoice:EXPIRED:${payload.id}`; const existing = await tx.idempotencyKey.findUnique({where: {key: idempotencyKey}}); if (existing) { console.info(`[processPaymentFailed] dedup key hit key=${idempotencyKey}`); return; }. AFTER the existing tx.order.update transitioning Order to PAYMENT_FAILED, add: await tx.idempotencyKey.create({data: {key: idempotencyKey}}); so the key is persisted only on successful completion. The existing orphan-tolerance return, FAILED idempotent no-op return, and CAPTURED-then-EXPIRED no-op all remain unchanged. PAID and EXPIRED keys are distinct (different event segments) so they never collide for the same invoice ID. (refs: DL-002, DL-003, DL-004, DL-005, DL-007)
- **CI-M-001-005** `src/features/payments/payouts/handlers.ts::processSettlement`: Inside the existing prisma.$transaction block, BEFORE the Step 1 tx.payout.findUnique({where:{externalPayoutId: payload.id}}) call, add: const idempotencyKey = `xendit:settlement:COMPLETED:${payload.id}`; const existing = await tx.idempotencyKey.findUnique({where: {key: idempotencyKey}}); if (existing) { console.info(`[processSettlement] dedup key hit key=${idempotencyKey}`); return; }. AFTER the Step 5 tx.labWallet.update balance move, add: await tx.idempotencyKey.create({data: {key: idempotencyKey}}); so the key is persisted only after both Payout.status=COMPLETED and the LabWallet balance move succeed. Place the create call AFTER the updateMany count===0 short-circuit check so concurrent-first-delivery losers (which return early via count===0) do NOT persist a key — only the winning delivery does, matching the existing concurrent-first-delivery semantics. The existing Step 2 findFirst orphan-tolerance return, Step 2.5 LabWallet missing throw, Step 3 negative-balance throw, and Step 4 updateMany count===0 short-circuit all remain unchanged. The settlement key dedups duplicate Xendit retries arriving after first delivery succeeds; the existing dual-lookup + externalPayoutId compare-and-set continues to handle the concurrent-first-delivery race. (refs: DL-002, DL-003, DL-004, DL-005, DL-006, DL-007)
- **CI-M-001-006** `src/features/payments/webhooks/__tests__/handlers.test.ts`: Add four integration test cases (testPrisma) to the existing file. (1) Inside the processPaymentCapture describe: 'returns early on duplicate delivery when IdempotencyKey already exists for the PAID key' — seed Order(PAYMENT_PENDING); Transaction(PENDING; externalId=TEST_TX_EXTERNAL_ID_5); and IdempotencyKey(key='xendit:invoice:PAID:'+TEST_TX_EXTERNAL_ID_5); call processPaymentCapture with that externalId; assert Transaction.status remains PENDING (no mutation); Order.status remains PAYMENT_PENDING; and exactly one IdempotencyKey row exists for that key. (2) Inside the processPaymentFailed describe: 'returns early on duplicate delivery when IdempotencyKey already exists for the EXPIRED key' — symmetric to (1) using xendit:invoice:EXPIRED:{id}; assert Transaction.status remains PENDING; Order.status remains PAYMENT_PENDING; and exactly one IdempotencyKey row exists for that key. (3) Inside processPaymentCapture describe: 'creates IdempotencyKey row inside the same transaction as the business writes' — seed Order + Transaction(PENDING) without pre-seeded key; call processPaymentCapture; assert Transaction.status=CAPTURED AND IdempotencyKey row with key='xendit:invoice:PAID:'+externalId exists. (4) Cross-event-type non-collision test inside processPaymentFailed describe: 'does NOT short-circuit when only the PAID IdempotencyKey exists for the same externalId' — seed Order(PAYMENT_PENDING); Transaction(PENDING; externalId=TEST_TX_EXTERNAL_ID_6); and IdempotencyKey(key='xendit:invoice:PAID:'+TEST_TX_EXTERNAL_ID_6) ONLY (no EXPIRED key); call processPaymentFailed with that externalId; assert Transaction.status=FAILED (mutation occurred — EXPIRED path was NOT short-circuited by the PAID key); Order.status=PAYMENT_FAILED; and a NEW IdempotencyKey row with key='xendit:invoice:EXPIRED:'+TEST_TX_EXTERNAL_ID_6 exists alongside the pre-seeded PAID key (two distinct keys for the same externalId). Extend cleanup() to deleteMany on idempotencyKey by key prefix matching the test IDs to keep the fixture self-contained. Reuse existing seedBase; TEST_USER/LAB/SERVICE constants; and the vi.mock of @/lib/prisma. (refs: DL-002, DL-003)
- **CI-M-001-007** `src/features/payments/payouts/__tests__/handlers.test.ts`: Add two integration test cases (testPrisma) to the existing file. (1) Inside the processSettlement describe: 'returns early on duplicate delivery when IdempotencyKey already exists for the settlement key' — seed Payout(QUEUED, externalPayoutId=null, platformFee=150.00), LabWallet(pendingBalance=150.00, availableBalance=0), and IdempotencyKey(key='xendit:settlement:COMPLETED:ext-settle-dup'); call processSettlement with payload.id='ext-settle-dup' and external_id matching the seeded order; assert Payout.status remains QUEUED, LabWallet balances unchanged. (2) 'creates IdempotencyKey row inside the same transaction as the balance move' — seed Payout(QUEUED, externalPayoutId=null, platformFee=150.00) + LabWallet(pendingBalance=150.00); call processSettlement with no pre-seeded key; assert Payout.status=COMPLETED AND IdempotencyKey row with key='xendit:settlement:COMPLETED:'+payload.id exists AND LabWallet balance moved. Extend cleanup() to deleteMany on idempotencyKey by the keys created in tests. Reuse existing seedBase fixture. (refs: DL-002, DL-006)
- **CI-M-001-008** `src/features/payments/payouts/__tests__/handlers-rollback.test.ts`: Add a mockIdempotencyKeyFindUnique vi.fn returning null and mockIdempotencyKeyCreate vi.fn resolving to ({key: 'xendit:settlement:COMPLETED:ext-settle-mock'}) on the mockTx object — both required so the new IdempotencyKey path inside processSettlement is mockable. Add one rollback test: 'rejects when idempotencyKey.create throws, confirming key creation participates in transaction atomicity' — override mockIdempotencyKeyCreate to mockRejectedValueOnce(new Error('idempotency-create-failure')); call processSettlement; assert rejects with that error. Two existing rollback tests (wallet-update-failure, payout-update-failure) remain valid; the new mock fields must be added to mockTx so they do not throw 'method undefined' at runtime. (refs: DL-002)
- **CI-M-001-009** `src/features/payments/webhooks/README.md`: Update the Idempotency section to document the layered dedup design: layer 1 is the IdempotencyKey table (key='xendit:invoice:PAID:{externalId}' for PAID and 'xendit:invoice:EXPIRED:{externalId}' for EXPIRED) which short-circuits before any Transaction lookup; layer 2 is the existing Transaction.status guard (CAPTURED returns early, FAILED throws under PAID for R-007 EXPIRED-then-PAID race). State that PAID and EXPIRED keys are distinct because they encode different state transitions for the same invoice ID. State that the IdempotencyKey row is created inside the same $transaction as the business writes so a handler throw rolls back the key alongside the writes (Xendit retry sees no key and re-attempts the work). (refs: DL-002, DL-003, DL-004, DL-007)
- **CI-M-001-010** `src/features/payments/payouts/README.md`: Update the Idempotency section to document the three-layer dedup design: layer 1 is the IdempotencyKey table (key='xendit:settlement:COMPLETED:{payload.id}') which short-circuits before any Payout lookup; layer 2 is the existing dual-lookup Payout.externalPayoutId @unique + Payout.status==COMPLETED early return; layer 3 is the updateMany compare-and-set on (id, externalPayoutId:null) with count===0 short-circuit for the concurrent-first-delivery race. State that the IdempotencyKey row is created AFTER the count===0 short-circuit so concurrent-first-delivery losers do not persist a key — only the winning delivery does. State that the IdempotencyKey row is created inside the same $transaction as the Payout.updateMany and LabWallet.update so a handler throw rolls back the key alongside the writes. (refs: DL-002, DL-003, DL-004, DL-006, DL-007)
- **CI-M-001-011** `src/features/payments/CLAUDE.md`: No row addition needed for the IdempotencyKey itself (it is a schema model, not a slice). Add a single sentence to the slice-purpose paragraph at the top of the file: 'Each handler also writes an IdempotencyKey row inside its $transaction (key xendit:{product}:{event}:{externalId}) for cross-provider dedup.' The Subdirectories table is unchanged. (refs: DL-003)

#### Code Changes

**CC-M-001-001** (prisma/schema.prisma) - implements CI-M-001-001

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -308,3 +308,16 @@ model LabWallet {
 
   @@map("lab_wallets")
 }
+
+// Provider-agnostic dedup row. Key format: provider:product:event:externalId
+// e.g. xendit:invoice:PAID:{invoiceId}, xendit:invoice:EXPIRED:{invoiceId},
+// xendit:settlement:COMPLETED:{settlementId}.
+// processedAt is informational (no TTL — append-only at current scale).
+model IdempotencyKey {
+  id          String   @id @default(cuid())
+  key         String   @unique
+  processedAt DateTime @default(now())
+
+  @@map("idempotency_keys")
+}
```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -311,7 +311,8 @@ model LabWallet {

 // Provider-agnostic dedup row. Key format: provider:product:event:externalId
-// e.g. xendit:invoice:PAID:{invoiceId}, xendit:invoice:EXPIRED:{invoiceId},
-// xendit:settlement:COMPLETED:{settlementId}.
-// processedAt is informational (no TTL — append-only at current scale).
+// Examples: xendit:invoice:PAID:{invoiceId}, xendit:invoice:EXPIRED:{invoiceId},
+// xendit:settlement:COMPLETED:{settlementId}. PAID and EXPIRED for the same
+// invoiceId are distinct keys (different state-machine transitions). (ref: DL-003)
+// processedAt is informational only; no TTL — append-only at current scale. (ref: DL-001)
 model IdempotencyKey {
   id          String   @id @default(cuid())

```


**CC-M-001-002** (prisma/migrations/20260519120000_add_idempotency_keys/migration.sql) - implements CI-M-001-002

**Code:**

```diff
--- /dev/null
+++ b/prisma/migrations/20260519120000_add_idempotency_keys/migration.sql
@@ -0,0 +1,7 @@
+-- CreateTable
+CREATE TABLE "idempotency_keys" (
+    "id" TEXT NOT NULL,
+    "key" TEXT NOT NULL,
+    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+
+    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
+);
+
+-- CreateIndex
+CREATE UNIQUE INDEX "idempotency_keys_key_key" ON "idempotency_keys"("key");
```

**Documentation:**

```diff
--- a/prisma/migrations/20260519120000_add_idempotency_keys/migration.sql
+++ b/prisma/migrations/20260519120000_add_idempotency_keys/migration.sql
@@ -1,2 +1,3 @@
+-- IdempotencyKey: provider-agnostic dedup table. key is @unique (Prisma enforces via unique index). (ref: DL-001)
 -- CreateTable
 CREATE TABLE "idempotency_keys" (

```


**CC-M-001-003** (src/features/payments/webhooks/handlers.ts) - implements CI-M-001-003

**Code:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -25,6 +25,14 @@ export async function processPaymentCapture(payload: XenditInvoicePayload): Pro
   await prisma.$transaction(async (tx) => {
-    // Lookup by externalId (Xendit invoice ID), not Transaction.id (our cuid). (ref: DL-004)
-    // findUnique enforces the @unique constraint at query level (Implementation Discipline).
-    const transaction = await tx.transaction.findUnique({
+    const idempotencyKey = `xendit:invoice:PAID:${payload.id}`
+    const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
+    if (existing) {
+      console.info(`[processPaymentCapture] dedup key hit key=${idempotencyKey}`)
+      return
+    }
+
+    // Lookup by externalId (Xendit invoice ID), not Transaction.id (our cuid). (ref: DL-004)
+    // findUnique enforces the @unique constraint at query level (Implementation Discipline).
+    const transaction = await tx.transaction.findUnique({
       where: { externalId: payload.id },
     })
@@ -69,6 +77,8 @@ export async function processPaymentCapture(payload: XenditInvoicePayload): Pro
     // Delegates Order.status transition to orders slice — ADR-001 fan-out pattern. (ref: DL-001)
     await handlePaymentCaptured(event, tx)
+
+    await tx.idempotencyKey.create({ data: { key: idempotencyKey } })
   })
 }
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -15,11 +15,14 @@ import type { XenditInvoicePayload } from './types'
 /**
- * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, and dispatches
- * PaymentCapturedEvent to the orders slice handler — all within one $transaction.
- * No LabWallet write; commission is tracked via Payout records created inside
- * completeOrder at order completion. (ref: DL-001, DL-016)
+ * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, and dispatches
+ * PaymentCapturedEvent to the orders slice handler — all within one $transaction.
+ * No LabWallet write; commission is tracked via Payout records created inside
+ * completeOrder at order completion. (ref: DL-001, DL-016)
  *
- * Returns early (200 to caller) if Transaction is not found (orphan tolerance) or
- * already CAPTURED (idempotency). Both guards are inside the transaction boundary
- * to prevent race conditions from concurrent Xendit deliveries. (ref: DL-004, DL-007)
+ * Dedup uses two layers: (1) IdempotencyKey row with key xendit:invoice:PAID:{id} —
+ * checked first, created last inside the $transaction; key persistence is atomically
+ * tied to business-write success; a handler throw rolls back the key so Xendit retries
+ * land on an empty lookup. (ref: DL-002, DL-007) (2) Transaction.status===CAPTURED guard —
+ * enforces the terminal-CAPTURED state-machine invariant independent of dedup. (ref: DL-004)
+ * Both layers required; see README.md Idempotency section.
  */
 export async function processPaymentCapture(payload: XenditInvoicePayload): Promise<void> {

```


**CC-M-001-004** (src/features/payments/webhooks/handlers.ts) - implements CI-M-001-004

**Code:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -85,6 +85,14 @@ export async function processPaymentFailed(payload: XenditInvoicePayload): Prom
 
   await prisma.$transaction(async (tx) => {
-    // findUnique enforces the @unique constraint at query level (Implementation Discipline).
-    const transaction = await tx.transaction.findUnique({
+    const idempotencyKey = `xendit:invoice:EXPIRED:${payload.id}`
+    const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
+    if (existing) {
+      console.info(`[processPaymentFailed] dedup key hit key=${idempotencyKey}`)
+      return
+    }
+
+    // findUnique enforces the @unique constraint at query level (Implementation Discipline).
+    const transaction = await tx.transaction.findUnique({
       where: { externalId: payload.id },
     })
@@ -130,6 +138,8 @@ export async function processPaymentFailed(payload: XenditInvoicePayload): Prom
     await tx.order.update({
       where: { id: transaction.orderId },
       data: { status: OrderStatus.PAYMENT_FAILED },
     })
+
+    await tx.idempotencyKey.create({ data: { key: idempotencyKey } })
   })
 }
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -85,7 +85,11 @@ export async function processPaymentCapture(payload: XenditInvoicePayload): Pro
 /**
- * Marks Transaction FAILED and transitions Order PAYMENT_PENDING→PAYMENT_FAILED.
- * Mirrors processPaymentCapture: same $transaction boundary, orphan tolerance,
- * idempotency-by-terminal-status. (ref: DL-001)
- * No LabWallet write — failed payments produce no lab credit. (ref: DL-007)
+ * Marks Transaction FAILED and transitions Order PAYMENT_PENDING→PAYMENT_FAILED
+ * within one $transaction. Mirrors processPaymentCapture structure: same dedup layers,
+ * orphan tolerance, no LabWallet write (failed payments produce no lab credit). (ref: DL-001)
+ *
+ * Dedup Layer 1: IdempotencyKey key xendit:invoice:EXPIRED:{id} — checked first, created
+ * last. (ref: DL-002) Layer 2: Transaction.status===FAILED guard (idempotent no-op) and
+ * status===CAPTURED guard (PAID-then-EXPIRED concurrent delivery — return early rather
+ * than throw, because CAPTURED is the correct terminal state). Both layers required.
  */
 export async function processPaymentFailed(payload: XenditInvoicePayload): Promise<void> {

```


**CC-M-001-005** (src/features/payments/payouts/handlers.ts) - implements CI-M-001-005

**Code:**

```diff
--- a/src/features/payments/payouts/handlers.ts
+++ b/src/features/payments/payouts/handlers.ts
@@ -23,6 +23,14 @@ export async function processSettlement(payload: XenditSettlementPayload): Prom
 
   await prisma.$transaction(async (tx) => {
-    // Step 1: idempotency check — look up by externalPayoutId (@unique, Implementation Discipline).
-    let payout = await tx.payout.findUnique({
+    const idempotencyKey = `xendit:settlement:COMPLETED:${payload.id}`
+    const existingKey = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
+    if (existingKey) {
+      console.info(`[processSettlement] dedup key hit key=${idempotencyKey}`)
+      return
+    }
+
+    // Step 1: idempotency check — look up by externalPayoutId (@unique, Implementation Discipline).
+    let payout = await tx.payout.findUnique({
       where: { externalPayoutId: payload.id },
     })
@@ -106,6 +114,8 @@ export async function processSettlement(payload: XenditSettlementPayload): Prom
     // Step 5: atomic balance move — both deltas in one update call.
     await tx.labWallet.update({
       where: { labId: payout.labId },
       data: {
         pendingBalance: { decrement: payout.platformFee },
         availableBalance: { increment: payout.platformFee },
       },
     })
+
+    await tx.idempotencyKey.create({ data: { key: idempotencyKey } })
   })
 }
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/handlers.ts
+++ b/src/features/payments/payouts/handlers.ts
@@ -11,10 +11,19 @@ import type { XenditSettlementPayload } from './types'
 /**
- * Transitions a QUEUED Payout to COMPLETED and atomically moves Payout.platformFee
- * from LabWallet.pendingBalance to LabWallet.availableBalance.
+ * Transitions a QUEUED Payout to COMPLETED and atomically moves Payout.platformFee
+ * from LabWallet.pendingBalance to LabWallet.availableBalance within one $transaction.
  *
- * Idempotent: duplicate delivery (externalPayoutId already set, status COMPLETED) returns early.
- * Orphan-tolerant: no Payout found for the settlement ID or orderId returns early.
- * Throws for unexpected Payout statuses (PROCESSING/FAILED) — contract violation.
- * Throws if LabWallet.pendingBalance would go negative — upstream invariant violated.
+ * Dedup uses three layers: (1) IdempotencyKey key xendit:settlement:COMPLETED:{id} —
+ * checked first inside $transaction; created AFTER the updateMany count===0 check so
+ * concurrent-first-delivery losers (which return early via count===0) do not persist a
+ * key. (ref: DL-002, DL-006) (2) Dual Payout lookup: findUnique by externalPayoutId
+ * (Step 1 idempotency for deliveries where externalPayoutId is already set) + findFirst
+ * by orderId+QUEUED+null (Step 2 first-delivery lookup). Uses findUnique+create over
+ * upsert: findUnique gives unambiguous null-vs-row signal; create enforces @unique at
+ * commit time to close the concurrent-delivery race. (ref: DL-005) (3) updateMany
+ * compare-and-set with {id, externalPayoutId:null} guard + count===0 short-circuit for
+ * simultaneous first-delivery races. (ref: DL-004)
+ *
+ * Orphan-tolerant (no Payout → return early). Throws for PROCESSING/FAILED (contract
+ * violation per Implementation Discipline) and negative pendingBalance.
  */
 export async function processSettlement(payload: XenditSettlementPayload): Promise<void> {

```


**CC-M-001-006** (src/features/payments/webhooks/__tests__/handlers.test.ts) - implements CI-M-001-006

**Code:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -29,6 +29,10 @@ const TEST_TX_EXTERNAL_ID_3 = 'xendit-test-ext-3'
 const TEST_TX_EXTERNAL_ID_4 = 'xendit-test-ext-4'
+const TEST_TX_EXTERNAL_ID_5 = 'xendit-test-ext-5'
+const TEST_TX_EXTERNAL_ID_6 = 'xendit-test-ext-6'
+const TEST_ORDER_ID_3 = 'test-order-3'
+const TEST_ORDER_ID_4 = 'test-order-4'
 
 async function cleanup() {
+  await testPrisma.idempotencyKey.deleteMany({
+    where: {
+      key: {
+        in: [
+          ,
+          ,
+          ,
+          ,
+        ],
+      },
+    },
+  })
-  await testPrisma.payout.deleteMany({ where: { orderId: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } } })
+  await testPrisma.payout.deleteMany({
+    where: { orderId: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2, TEST_ORDER_ID_3, TEST_ORDER_ID_4] } },
+  })
   await testPrisma.labWallet.deleteMany({ where: { labId: TEST_LAB_ID } })
   await testPrisma.transaction.deleteMany({
     where: {
       externalId: {
-        in: [TEST_TX_EXTERNAL_ID_1, TEST_TX_EXTERNAL_ID_2, TEST_TX_EXTERNAL_ID_3, TEST_TX_EXTERNAL_ID_4],
+        in: [
+          TEST_TX_EXTERNAL_ID_1,
+          TEST_TX_EXTERNAL_ID_2,
+          TEST_TX_EXTERNAL_ID_3,
+          TEST_TX_EXTERNAL_ID_4,
+          TEST_TX_EXTERNAL_ID_5,
+          TEST_TX_EXTERNAL_ID_6,
+        ],
       },
     },
   })
-  await testPrisma.order.deleteMany({ where: { id: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } } })
+  await testPrisma.order.deleteMany({
+    where: { id: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2, TEST_ORDER_ID_3, TEST_ORDER_ID_4] } },
+  })
 
@@ -224,6 +241,75 @@ describe('processPaymentCapture', () => {
     await expect(processPaymentCapture(payload)).rejects.toThrow(/FAILED/)
   })
+
+  it('returns early on duplicate delivery when IdempotencyKey already exists for the PAID key', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_3,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.PAYMENT_PENDING,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-idem-paid',
+        orderId: TEST_ORDER_ID_3,
+        externalId: TEST_TX_EXTERNAL_ID_5,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.PENDING,
+      },
+    })
+    await testPrisma.idempotencyKey.create({
+      data: { key:  },
+    })
+
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_5,
+      status: 'PAID',
+      paid_amount: 1500,
+      payer_email: 'client@test.local',
+    }
+
+    await processPaymentCapture(payload)
+
+    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_5 } })
+    expect(tx!.status).toBe(TransactionStatus.PENDING)
+    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_3 } })
+    expect(order!.status).toBe(OrderStatus.PAYMENT_PENDING)
+    const keys = await testPrisma.idempotencyKey.findMany({
+      where: { key:  },
+    })
+    expect(keys).toHaveLength(1)
+  })
+
+  it('creates IdempotencyKey row inside the same transaction as the business writes', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_4,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.PAYMENT_PENDING,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-idem-create',
+        orderId: TEST_ORDER_ID_4,
+        externalId: TEST_TX_EXTERNAL_ID_6,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.PENDING,
+      },
+    })
+
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_6,
+      status: 'PAID',
+      paid_amount: 1500,
+      payer_email: 'client@test.local',
+    }
+
+    await processPaymentCapture(payload)
+
+    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_6 } })
+    expect(tx!.status).toBe(TransactionStatus.CAPTURED)
+    const key = await testPrisma.idempotencyKey.findUnique({
+      where: { key:  },
+    })
+    expect(key).not.toBeNull()
+  })
 })
 
@@ -344,6 +430,76 @@ describe('processPaymentFailed', () => {
   it('returns without error when Transaction is not found (orphan tolerance)', async () => {
+
+  it('returns early on duplicate delivery when IdempotencyKey already exists for the EXPIRED key', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_3,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.PAYMENT_PENDING,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-idem-expired',
+        orderId: TEST_ORDER_ID_3,
+        externalId: TEST_TX_EXTERNAL_ID_5,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.PENDING,
+      },
+    })
+    await testPrisma.idempotencyKey.create({
+      data: { key:  },
+    })
+
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_5,
+      status: 'EXPIRED',
+      paid_amount: 0,
+      payer_email: 'client@test.local',
+    }
+
+    await processPaymentFailed(payload)
+
+    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_5 } })
+    expect(tx!.status).toBe(TransactionStatus.PENDING)
+    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_3 } })
+    expect(order!.status).toBe(OrderStatus.PAYMENT_PENDING)
+    const keys = await testPrisma.idempotencyKey.findMany({
+      where: { key:  },
+    })
+    expect(keys).toHaveLength(1)
+  })
+
+  it('does NOT short-circuit when only the PAID IdempotencyKey exists for the same externalId', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_4,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.PAYMENT_PENDING,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-cross-event',
+        orderId: TEST_ORDER_ID_4,
+        externalId: TEST_TX_EXTERNAL_ID_6,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.PENDING,
+      },
+    })
+    await testPrisma.idempotencyKey.create({
+      data: { key:  },
+    })
+
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_6,
+      status: 'EXPIRED',
+      paid_amount: 0,
+      payer_email: 'client@test.local',
+    }
+
+    await processPaymentFailed(payload)
+
+    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_6 } })
+    expect(tx!.status).toBe(TransactionStatus.FAILED)
+    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_4 } })
+    expect(order!.status).toBe(OrderStatus.PAYMENT_FAILED)
+    const expiredKey = await testPrisma.idempotencyKey.findUnique({
+      where: { key:  },
+    })
+    expect(expiredKey).not.toBeNull()
+    const paidKey = await testPrisma.idempotencyKey.findUnique({
+      where: { key:  },
+    })
+    expect(paidKey).not.toBeNull()
+  })
 })
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -1,3 +1,9 @@
+/**
+ * Integration tests for processPaymentCapture and processPaymentFailed. (ref: DL-002)
+ * Runs against real test database (DATABASE_TEST_URL) to catch FK constraint
+ * and Decimal type mismatches that mocked Prisma would hide.
+ * IdempotencyKey rows are cleaned up in the cleanup() function before each test.
+ */
 import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
 import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode, PayoutStatus } from '@prisma/client'
 import { testPrisma } from '@/test/test-prisma'

```


**CC-M-001-007** (src/features/payments/payouts/__tests__/handlers.test.ts) - implements CI-M-001-007

**Code:**

```diff
--- a/src/features/payments/payouts/__tests__/handlers.test.ts
+++ b/src/features/payments/payouts/__tests__/handlers.test.ts
@@ -29,6 +29,11 @@ const TEST_PAYOUT_ID_4 = 'test-settle-payout-4'
 const TEST_PAYOUT_ID_5 = 'test-settle-payout-5'
+const TEST_PAYOUT_ID_6 = 'test-settle-payout-6'
+const TEST_PAYOUT_ID_7 = 'test-settle-payout-7'
+const EXT_SETTLE_DUP = 'ext-settle-dup'
+const EXT_SETTLE_KEY_CREATE = 'ext-settle-key-create'
 const EXT_SETTLE_1 = 'ext-settle-1'
 
@@ -39,6 +44,14 @@ async function cleanup() {
+  await testPrisma.idempotencyKey.deleteMany({
+    where: {
+      key: {
+        in: [
+          ,
+          ,
+        ],
+      },
+    },
+  })
   await testPrisma.payout.deleteMany({
     where: {
       id: {
         in: [
           TEST_PAYOUT_ID_1,
           TEST_PAYOUT_ID_2,
           TEST_PAYOUT_ID_3,
           TEST_PAYOUT_ID_4,
           TEST_PAYOUT_ID_5,
+          TEST_PAYOUT_ID_6,
+          TEST_PAYOUT_ID_7,
         ],
       },
     },
   })
 
@@ -248,3 +261,72 @@ describe('processSettlement', () => {
   it('PROCESSING contract violation — rejects with Error matching /PROCESSING/', async () => {
+
+  it('returns early on duplicate delivery when IdempotencyKey already exists for the settlement key', async () => {
+    await testPrisma.payout.create({
+      data: {
+        id: TEST_PAYOUT_ID_6,
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
+    await testPrisma.idempotencyKey.create({
+      data: { key:  },
+    })
+
+    const payload: XenditSettlementPayload = {
+      id: EXT_SETTLE_DUP,
+      status: 'COMPLETED',
+      amount: 1500,
+      external_id: TEST_ORDER_ID_1,
+    }
+
+    await processSettlement(payload)
+
+    const payout = await testPrisma.payout.findUnique({ where: { id: TEST_PAYOUT_ID_6 } })
+    expect(payout!.status).toBe(PayoutStatus.QUEUED)
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet!.pendingBalance.toFixed(2)).toBe('150.00')
+    expect(wallet!.availableBalance.toFixed(2)).toBe('0.00')
+  })
+
+  it('creates IdempotencyKey row inside the same transaction as the balance move', async () => {
+    await testPrisma.payout.create({
+      data: {
+        id: TEST_PAYOUT_ID_7,
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
+      id: EXT_SETTLE_KEY_CREATE,
+      status: 'COMPLETED',
+      amount: 1500,
+      external_id: TEST_ORDER_ID_1,
+    }
+
+    await processSettlement(payload)
+
+    const payout = await testPrisma.payout.findUnique({ where: { id: TEST_PAYOUT_ID_7 } })
+    expect(payout!.status).toBe(PayoutStatus.COMPLETED)
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet!.pendingBalance.toFixed(2)).toBe('0.00')
+    expect(wallet!.availableBalance.toFixed(2)).toBe('150.00')
+    const key = await testPrisma.idempotencyKey.findUnique({
+      where: { key:  },
+    })
+    expect(key).not.toBeNull()
+  })
 })
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/__tests__/handlers.test.ts
+++ b/src/features/payments/payouts/__tests__/handlers.test.ts
@@ -1,7 +1,9 @@
 /**
- * Integration tests for processSettlement against real test DB (testPrisma + DATABASE_TEST_URL).
- * Real DB validates Decimal arithmetic, FK constraints, and $transaction atomicity. (ref: DL-011)
- * Covers: first delivery, idempotent duplicate, orphan tolerance (unknown externalPayoutId),
- * orphan tolerance (unknown orderId), negative-balance guard, PROCESSING contract violation.
+ * Integration tests for processSettlement against real test DB (testPrisma + DATABASE_TEST_URL).
+ * Real DB validates Decimal arithmetic, FK constraints, and $transaction atomicity. (ref: DL-011)
+ * Covers: first delivery, idempotent duplicate (IdempotencyKey layer + COMPLETED status guard),
+ * orphan tolerance (unknown externalPayoutId), orphan tolerance (unknown orderId),
+ * negative-balance guard, PROCESSING contract violation.
+ * IdempotencyKey rows are cleaned up in the cleanup() function before each test.
  */
 import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

```


**CC-M-001-008** (src/features/payments/payouts/__tests__/handlers-rollback.test.ts) - implements CI-M-001-008

**Code:**

```diff
--- a/src/features/payments/payouts/__tests__/handlers-rollback.test.ts
+++ b/src/features/payments/payouts/__tests__/handlers-rollback.test.ts
@@ -11,6 +11,8 @@ import { PayoutStatus } from '@prisma/client'
 
+const mockIdempotencyKeyFindUnique = vi.fn().mockResolvedValue(null)
+const mockIdempotencyKeyCreate = vi.fn().mockResolvedValue({ key: 'xendit:settlement:COMPLETED:ext-settle-mock' })
 const mockPayoutFindUnique = vi.fn().mockResolvedValue(null)
 
@@ -28,6 +30,9 @@ const mockWalletUpdate = vi.fn().mockRejectedValue(new Error('wallet-update-failure'))
 
 const mockTx = {
+  idempotencyKey: {
+    findUnique: mockIdempotencyKeyFindUnique,
+    create: mockIdempotencyKeyCreate,
+  },
   payout: {
     findUnique: mockPayoutFindUnique,
     findFirst: mockPayoutFindFirst,
     updateMany: mockPayoutUpdateMany,
   },
   labWallet: {
     findUnique: mockWalletFindUnique,
     update: mockWalletUpdate,
   },
 }
 
@@ -62,3 +66,9 @@ describe('processSettlement — rollback error propagation', () => {
   it('rejects when payout.updateMany throws, confirming error propagation triggers Prisma rollback', async () => {
     mockPayoutUpdateMany.mockRejectedValueOnce(new Error('payout-update-failure'))
     await expect(processSettlement(basePayload)).rejects.toThrow('payout-update-failure')
   })
+
+  it('rejects when idempotencyKey.create throws, confirming key creation participates in transaction atomicity', async () => {
+    mockWalletUpdate.mockResolvedValueOnce({})
+    mockIdempotencyKeyCreate.mockRejectedValueOnce(new Error('idempotency-create-failure'))
+
+    await expect(processSettlement(basePayload)).rejects.toThrow('idempotency-create-failure')
+  })
 })
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/__tests__/handlers-rollback.test.ts
+++ b/src/features/payments/payouts/__tests__/handlers-rollback.test.ts
@@ -1,7 +1,9 @@
 /**
- * Rollback error propagation tests using a full Prisma mock. (ref: DL-011)
- * Real DB cannot exercise rollback isolation without schema-breaking teardown, so mocks
- * are used for this single concern. Confirms that errors from payout.update and
- * labWallet.update propagate out of $transaction, causing Xendit to receive 500 and retry.
+ * Rollback error propagation tests using a full Prisma mock. (ref: DL-011)
+ * Real DB cannot exercise rollback isolation without schema-breaking teardown, so mocks
+ * are used for this single concern. Confirms that errors from payout.updateMany and
+ * labWallet.update propagate out of $transaction, causing Xendit to receive 500 and retry.
+ * mockIdempotencyKeyCreate is named to match the handler's tx.idempotencyKey.create call
+ * per Implementation Discipline (misnamed mock silently voids the assertion). (ref: R-001)
  */
 import { describe, it, expect, vi } from 'vitest'

```


**CC-M-001-009** (src/features/payments/webhooks/README.md) - implements CI-M-001-009

**Code:**

```diff
--- a/src/features/payments/webhooks/README.md
+++ b/src/features/payments/webhooks/README.md
@@ -50,8 +50,28 @@ If the lookup fails or the Transaction is already `CAPTURED`, the handler returns 200
## Invariants
 
-- Idempotency check (`findUnique` on `Transaction.externalId` + status guard) is inside `$transaction`
+## Idempotency
+
+Duplicate detection uses two layered guards:
+
+**Layer 1 - IdempotencyKey table (broad, schema-level):** key xendit:invoice:PAID:{externalId} for PAID; xendit:invoice:EXPIRED:{externalId} for EXPIRED. Check is first step inside $transaction; create is last step. PAID and EXPIRED keys are distinct.
+
+**Layer 2 - Transaction.status guard (precise, state-machine):** CAPTURED early return (PAID); FAILED throw R-007 (PAID); FAILED early return (EXPIRED); CAPTURED early return (EXPIRED). Both layers required.
+
+## Invariants
+
+- Idempotency guard (IdempotencyKey layer + Transaction.status layer) is inside `$transaction`
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/README.md
+++ b/src/features/payments/webhooks/README.md
@@ -124,4 +124,6 @@ A test added to `handlers.test.ts` that mocks Prisma would silently defeat the
 purpose of the real-DB tests — mocked Decimal arithmetic does not catch
 `toFixed()` regressions or FK constraint violations. Keep tests 1-3 on the real
-DB; add new mock-based tests to `handlers-rollback.test.ts`.
+DB; add new mock-based tests to `handlers-rollback.test.ts`.
+
+IdempotencyKey dedup tests (duplicate delivery returns early) live in `handlers.test.ts` alongside the real-DB capture tests because they require a pre-seeded IdempotencyKey row and real DB cleanup.

```


**CC-M-001-010** (src/features/payments/payouts/README.md) - implements CI-M-001-010

**Code:**

```diff
--- a/src/features/payments/payouts/README.md
+++ b/src/features/payments/payouts/README.md
@@ -46,8 +46,18 @@ Both directions are set by the checkout slice:
## Idempotency
 
-Duplicate detection uses `Payout.externalPayoutId` (`@unique`) as the native idempotency key.
+Duplicate detection uses three layered guards:
+
+**Layer 1 - IdempotencyKey table:** key xendit:settlement:COMPLETED:{payload.id}. Created after count===0 short-circuit so concurrent losers do not persist a key. Created inside same $transaction as business writes.
+
+**Layer 2 - Dual Payout lookup:** Step 1 findUnique by externalPayoutId; Step 2 findFirst QUEUED by orderId+null.
+
+**Layer 3 - updateMany compare-and-set:** {id, externalPayoutId:null} guard with count===0 short-circuit for simultaneous first-delivery races.
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/README.md
+++ b/src/features/payments/payouts/README.md
@@ -82,4 +82,5 @@ Same split as `webhooks/` slice:
 - `__tests__/handlers.test.ts` — real test DB (DATABASE_TEST_URL) for ledger correctness:
-  first delivery, idempotent duplicate, orphan tolerance, negative-balance guard, PROCESSING contract violation.
+  first delivery, idempotent duplicate (IdempotencyKey layer + COMPLETED status layer), orphan
+  tolerance, negative-balance guard, PROCESSING contract violation.
 - `__tests__/handlers-rollback.test.ts` — full Prisma mock for rollback error propagation.
 

```


**CC-M-001-011** (src/features/payments/CLAUDE.md) - implements CI-M-001-011

**Code:**

```diff
--- a/src/features/payments/CLAUDE.md
+++ b/src/features/payments/CLAUDE.md
@@ -1,6 +1,6 @@ # payments/
 
-Payment feature slices. Each subdirectory is one vertical slice.
+Payment feature slices. Each subdirectory is one vertical slice. Each handler also writes an IdempotencyKey row inside its $transaction (key xendit:{product}:{event}:{externalId}) for cross-provider dedup.
```

**Documentation:**

```diff
--- a/src/features/payments/CLAUDE.md
+++ b/src/features/payments/CLAUDE.md
@@ -7,5 +7,5 @@ Payment feature slices. Each subdirectory is one vertical slice. Each handler al
 | Directory    | What                                                                       | When to read                                              |
 | ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
 | `checkout/`  | Deferred-payment checkout — Xendit invoice creation and redirect           | Implementing or modifying the PAYMENT_PENDING pay flow    |
-| `payouts/`   | Xendit settlement webhook — confirms commission split settled into PipetGo account, transitions Payout QUEUED -> COMPLETED, moves Payout.platformFee from LabWallet.pendingBalance to availableBalance; integration tests in `payouts/__tests__/` | Implementing or modifying commission settlement, lab wallet balance moves, or settlement integration tests |
-| `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler; no LabWallet write (AD-001); integration tests in `webhooks/__tests__/` | Implementing or modifying webhook payment capture or payment capture tests |
+| `payouts/`   | Xendit settlement webhook — confirms commission split, transitions Payout QUEUED->COMPLETED, moves Payout.platformFee pendingBalance->availableBalance; three-layer idempotency (IdempotencyKey + dual-lookup + updateMany CAS); integration tests in `payouts/__tests__/` | Implementing or modifying commission settlement, lab wallet balance moves, or settlement integration tests |
+| `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler; two-layer idempotency (IdempotencyKey + status guard); no LabWallet write (AD-001); integration tests in `webhooks/__tests__/` | Implementing or modifying webhook payment capture or payment capture tests |

```

