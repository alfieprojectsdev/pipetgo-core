# Refund execution (close the T-19 redress loop) — playbook

Plan document: `plans/T21-refund-execution.md` (to be written by the planner) — **proposed ticket id
T-21; assign the next free T-id when you add it to the roadmap.**
Branch: `feat/T21-refund-execution`
Estimated sessions: 2–3 | Estimated wall time: ~4–5 hours
Why this is next: T-19 shipped the dispute flow but `RESOLVED_REFUND` only sets
`Order.status = REFUND_PENDING` (DL-007) — **no money moves.** ITA 2023 redress is not actually
complete until a client refund processes. This ticket fills the gap between the existing
`REFUND_PENDING → REFUNDED` state edge and the money: execute a Xendit refund, confirm it via webhook,
flip the order to `REFUNDED`, and reconcile the lab payout/wallet.

> **HIGHEST-RISK TICKET SINCE THE PAYMENT SLICES — it moves money OUTBOUND and reverses a ledger.**
> Higher risk than T-19 (which only *held* funds). Outbound refund + payout void + wallet reversal,
> all idempotent under webhook retries. Treat every write with the `updateMany` CAS + `$transaction`
> + `IdempotencyKey` discipline; every external call with `AbortSignal.timeout(10_000)`.

> **OWES a schema migration + `npx prisma db push` per env** (almost certainly: a `PayoutStatus`
> terminal "voided" value and a refund-provider-id for idempotency — see Decisions 4 & 5).

---

## ⚠️ The T-19 interaction you must close (read first)

T-19's payout-hold predicate excludes **only `DISPUTED`**:
`order: { status: { not: OrderStatus.DISPUTED } }` (in `processSettlement`, both the `findFirst` and
the `updateMany` CAS). The moment an admin resolves `DISPUTED → REFUND_PENDING`, the order is **no
longer DISPUTED**, so the hold **lifts** — a settlement webhook could then release the lab payout for
an order that is being refunded. It's latent today only because the settlement path is **dormant**
(DL-012), but **this ticket must close it**, two options:
- **(preferred)** void/cancel the held `QUEUED` Payout + reverse its `LabWallet.pendingBalance` credit
  atomically at refund time, so there is nothing left to settle; **and**
- extend the hold predicate to also exclude `REFUND_PENDING` and `REFUNDED` (defence-in-depth).
Do both. This is the money-safety line of the ticket.

---

## The full cycle (planning → /clear → implement)

`[planner]` ticket. Phases in order.

### Phase A — Explore + Plan (session 1)
1. Resolve every Pre-session decision below FIRST (esp. Decisions 4 & 5 — they fix the migration).
2. Hand the planner the **anchor files** below (verified 2026-06-04):

   | File | Why it anchors the plan |
   | ---- | ----------------------- |
   | `src/domain/orders/state-machine.ts` | `REFUND_PENDING → [REFUNDED]` edge already exists; refund completion is the only `Order.status` write |
   | `prisma/schema.prisma` | `Order.refundedAt`, `Transaction.refundedAt` + `TransactionStatus.REFUNDED` already exist; `Payout`/`PayoutStatus` (void value — migration); `IdempotencyKey` |
   | `src/lib/payments/xendit.ts` | invoice client + the `AbortSignal.timeout` + `XenditVaError`-style rethrow discipline — add the refund call(s) here |
   | `src/lib/payments/xendit-va.ts` | FVA/VA client — VA refunds differ from invoice refunds (Decision 7) |
   | `src/lib/payments/webhook-auth.ts` | `timingSafeEqual` token verification — the refund webhook route reuses this |
   | `src/features/payments/webhooks/handlers.ts` | `processPaymentCapture` / `processPaymentFailed` — the **template for a new `processRefund` handler**; `updateMany` CAS + orphan tolerance + idempotency early-return |
   | `src/features/payments/webhooks/route.ts` | webhook dispatch — add the refund event branch |
   | `src/features/payments/payouts/handlers.ts` | T-19 payout-hold predicate (extend it) + the `LabWallet` pending/available move pattern to **reverse** |
   | `src/features/orders/dispute-resolution/action.ts` | T-19 `RESOLVED_REFUND → REFUND_PENDING` — the entry point; refund execute action mirrors its layer-2 ADMIN auth |
   | `src/features/labs/wallet/` | `LabWallet` balance display + DTO serialization pattern |
   | `src/domain/payments/commission.ts` | commission rate — the amount whose `pendingBalance` credit is reversed |

3. `python3 -m skills.planner.orchestrator.planner --step 1`.
4. Planner writes `plans/T21-refund-execution.md` (milestones + Code Intent/Changes + test plan).
5. Steelman each decision + quality-reviewer pass before "ready to implement".

### Phase B — `/clear`  (planner state on disk is the handoff)

### Phase C — Implement (session 2–3)
Worktree first: `git worktree add wt/T21-refund-execution -b feat/T21-refund-execution main`.
Test with `./scripts/test-local.sh`.

---

## The flow this ticket builds

```
[T-19] admin resolves dispute → RESOLVED_REFUND → Order.status = REFUND_PENDING
                                                  (held QUEUED Payout still exists)
            │
[T-21] admin "execute refund" action (layer-2 ADMIN):
            │   - look up the original Transaction (externalId, paymentMethod, amount)
            │   - call Xendit refund API (AbortSignal.timeout); store refund provider id
            │   - VOID the held QUEUED Payout + reverse LabWallet.pendingBalance  (one $transaction)
            │   - Order stays REFUND_PENDING until Xendit confirms
            ▼
[T-21] Xendit refund webhook → processRefund (idempotent, CAS):
            - Transaction.status → REFUNDED + refundedAt
            - Order REFUND_PENDING → REFUNDED + Order.refundedAt   (isValidStatusTransition)
            - write IdempotencyKey  (xendit:refund:<refund_id>)
```

---

## Pre-session — resolve these BEFORE calling the planner

### Decision 1 (trigger): auto-refund on `RESOLVED_REFUND`, or a separate explicit "execute refund"?
Recommendation: **separate, explicit admin "execute refund" action** — outbound money must be
deliberate, may need amount confirmation, and decouples the (instant) dispute verdict from the
(provider-dependent, retryable) money movement. `RESOLVED_REFUND` stays "intent"; execute is the act.

### Decision 2 (amount): full only, or partial?
Recommendation: **full refund only for v1** (refund the captured `Transaction.amount`). Partial refunds
add proration + multi-refund accounting; defer. State the cap in the plan.

### Decision 3 (when does `REFUNDED` get written): optimistic vs webhook-confirmed
Recommendation: **webhook-confirmed.** The execute action initiates the refund and leaves the order in
`REFUND_PENDING`; only the Xendit refund webhook (`processRefund`) flips `REFUND_PENDING → REFUNDED`.
Never mark `REFUNDED` optimistically — the money may not have actually moved.

### Decision 4 (THE money-safety + migration): void the held payout + reverse the wallet
The disputed order's `Payout` is `QUEUED` and its `platformFee` was credited to
`LabWallet.pendingBalance` at completion (T-09). On refund it must be **voided, not released**, and the
`pendingBalance` credit reversed — atomically, in one `$transaction`, `updateMany` CAS keyed on the
payout still being `QUEUED`. **`PayoutStatus` has no terminal "voided" value today** (QUEUED/PROCESSING/
COMPLETED/FAILED) — decide: add `CANCELLED` (migration) vs reuse `FAILED` + a reason. Recommendation:
**add `PayoutStatus.CANCELLED`** (clear intent; migration + `db push`). Also extend the T-19 hold
predicate to exclude `REFUND_PENDING`/`REFUNDED` (see the ⚠️ section).

### Decision 5 (idempotency + refund record): where does the provider refund id live?
The refund webhook needs a unique key. `Transaction` already has `refundedAt` + `status=REFUNDED`, but
**no refund-provider-id column.** Decide: add `Transaction.refundExternalId String? @unique` (migration)
vs a dedicated `Refund` model vs `metadata` JSON. Recommendation: **`refundExternalId @unique` on
`Transaction`** (minimal, gives DB-level idempotency) + `IdempotencyKey` `xendit:refund:<refund_id>` in
the webhook `$transaction` — mirrors `processSettlement`'s three-layer idempotency.

### Decision 6 (provider scope): Xendit only
PayMongo is deferred (AD-002). Refund via Xendit only; route through the `NormalizedWebhookPayload`
boundary so a future provider slots in. State PayMongo refund as out of scope.

### Decision 7 (per-method refund): invoice vs FVA/VA endpoints differ
Invoice payments (`xendit.ts`) and PESONet FVA (`xendit-va.ts`) refund through **different Xendit
endpoints/semantics**. Dispatch on `Transaction.paymentMethod`/`provider`. VA/bank refunds may require a
destination account and may be asynchronous — confirm the Xendit FVA refund capability in sandbox
before committing the plan (this is the riskiest unknown; verify, don't assume).

### Decision 8 (failure handling): a failed refund stays `REFUND_PENDING`, surfaced + retryable
If the Xendit refund call fails (or `TimeoutError`), the order stays `REFUND_PENDING`, the failure is
written (`Transaction.failureReason`) and rendered to the admin, and the execute action is **re-runnable**
(idempotent — a second execute must not double-refund: guard on `refundExternalId`/an in-flight marker).

---

## Watch-points during implementation
- **Every `Order.status` write calls `isValidStatusTransition()`** (only `REFUND_PENDING → REFUNDED` here).
- **`processRefund` webhook write is `updateMany` + guard predicate + `count===0` early-return** — never
  bare `update`; idempotency-key early-return first (three layers, like `processSettlement`).
- **Payout void + wallet reverse are in the SAME `$transaction`** as the refund-confirmation write — a
  partial reversal corrupts the ledger.
- **Negative-balance guard on the `pendingBalance` reversal** — throw, never clamp (mirror
  `processSettlement`'s negative-balance discipline).
- **Extend the T-19 hold predicate** to exclude `REFUND_PENDING`/`REFUNDED` (⚠️ section) — and cover it
  with the existing payouts test.
- **Every Xendit refund `fetch` has `signal: AbortSignal.timeout(10_000)`**; the catch rethrows
  `TimeoutError` (don't add a generic swallow).
- **Double-execute guard** — a second "execute refund" must no-op if a refund is already in-flight/done
  (Decision 8).
- **RSC→client**: any `Decimal`/`Date` on the refund/admin views serialized (`.toFixed(2)`/`.toISOString()`);
  no bare `toLocaleString()` in new client components.

## Tests (offline, `./scripts/test-local.sh`)
- `processRefund`: first delivery flips `Transaction`→REFUNDED + `Order` REFUND_PENDING→REFUNDED;
  duplicate delivery is a COMPLETED-style no-op; IdempotencyKey dedup early-returns; orphan tolerated.
- payout void: a held `QUEUED` payout → `CANCELLED` and `LabWallet.pendingBalance` reversed, in one tx;
  negative-balance attempt throws.
- hold predicate: settlement is **skipped** for a `REFUND_PENDING`/`REFUNDED` order (the ⚠️ fix).
- execute action: non-admin rejected (layer-2); a second execute does not double-refund (Decision 8).
- state guard: a non-`REFUND_PENDING` order cannot be refund-completed (`isValidStatusTransition`).
- mock names match handler Prisma calls (`updateMany`, not `update`).

## DevOps Pre-Flight (run before any "verify / deploy" step)
- `npx prisma db push` per env for `PayoutStatus.CANCELLED` + `Transaction.refundExternalId @unique`
  (DL-009 — unpushed = runtime crash, not a type error).
- Xendit **refund webhook** endpoint registered + its callback token in env (`webhook-auth.ts`
  `timingSafeEqual`); confirm the refund-event name/shape in the Xendit sandbox.
- Xendit API key has **refund** permission (not just charge/invoice) for the env.
- Settlement path is still dormant (DL-012) — the payout-void path is exercised by tests, not live
  traffic yet; the ⚠️ predicate fix is forward-insurance.

## Open questions to verify in Xendit sandbox (block the plan)
1. Refund endpoint + event shape for **invoice** payments vs **FVA/VA** payments (Decision 7).
2. Are FVA/bank refunds synchronous or webhook-confirmed, and do they need a destination account?
3. Refund provider-id field name (for `refundExternalId` + the idempotency key).
4. Partial-refund support (to confirm full-only is acceptable for v1).

## Protocol reminders
- PR per ticket; CodeRabbit auto-reviews; squash-merge + delete branch; `[planner]` full cycle.
- Highest money-risk since the payment slices — do the **pre-PR Implementation-Discipline audit** of the
  diff before opening the PR; don't rely on CodeRabbit alone.
- Run the **DevOps Readiness Protocol** on any provisioning/env gap.
- After this + the PII ticket merge, the **Compounding Protocol** trigger (3–5 PRs since #20) is due.
