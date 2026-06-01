# Plan

## Overview

When a Xendit invoice expires, the system silently drops the EXPIRED webhook event. src/features/payments/webhooks/route.ts short-circuits on payload.status !== 'PAID' before any DB write, so Order.status stays at PAYMENT_PENDING forever and Transaction.status stays PENDING — the client sees an indefinite Payment Pending badge with no way to retry. Compounding this: the checkout slice operates at /dashboard/orders/[orderId]/pay but the app router has no mount at that path, and T-07's acceptQuote redirects to /checkout/${orderId} which also has no mount.

**Approach**: Three coordinated changes that all reuse existing patterns: (1) A new processPaymentFailed handler in webhooks/handlers.ts mirrors processPaymentCapture line-for-line — same $transaction boundary, same orphan tolerance, same idempotency guard (Transaction already FAILED → return early), same isValidStatusTransition guard before Order.status write. The route handler gains an EXPIRED branch dispatching to it. (2) A retryPayment action is added to order-detail/action.ts following the acceptQuote pattern exactly, transitioning PAYMENT_FAILED→PAYMENT_PENDING and redirecting to the checkout page. ui.tsx gains an OrderDetailRetryPayment client component rendered when status === PAYMENT_FAILED. (3) Two app router mount bugs are closed: a new re-export at src/app/dashboard/orders/[orderId]/pay/page.tsx makes the checkout slice reachable, and acceptQuote's redirect target is corrected to that same path.

### Payment failure retry — EXPIRED webhook then client retry

[Diagram pending Technical Writer rendering: DIAG-001]

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | processPaymentFailed mirrors processPaymentCapture structure exactly — $transaction, orphan-tolerant findFirst, idempotency-by-terminal-status, throw-on-bad-transition | Both handlers are Xendit webhook reactions writing Transaction.status + Order.status atomically -> divergent structure would mean two patterns to maintain and two surfaces for race-condition bugs -> mirroring keeps webhook idempotency invariants (DL-004) in one mental model. Specifically: idempotency guard sits inside $transaction so concurrent EXPIRED deliveries do not double-write; Transaction findFirst by externalId returns early if absent (orphan tolerance); isValidStatusTransition throws on invalid edge so a webhook arriving for an ACKNOWLEDGED order rolls back rather than corrupting state. |
| DL-002 | retryPayment lives inline on order-detail/ slice; no separate retry-payment/ slice | PAYMENT_FAILED renders the same Order Summary + Contact Details + Status Timeline as every other status, plus one action card -> a separate slice would either duplicate the base rendering or import it (ADR-001 cross-slice violation) -> inline action panel matches the T-07 D3 precedent for acceptQuote/rejectQuote on the same slice. The slice CLAUDE.md already documents this asymmetry as intentional. |
| DL-003 | retryPayment redirects to /dashboard/orders/${orderId}/pay (not /checkout/${orderId}); acceptQuote /checkout/ redirect is corrected in the same PR | checkout/page.tsx documents its route as /dashboard/orders/[orderId]/pay (file-level comment) -> the /checkout/ tree has no app router mount, so acceptQuote already redirects to a 404 -> emitting another action redirecting to the same broken path would compound a known bug. The fix is one line in acceptQuote plus one new file at src/app/dashboard/orders/[orderId]/pay/page.tsx re-exporting the checkout slice (matching the established re-export pattern at src/app/dashboard/orders/[orderId]/page.tsx). |
| DL-004 | retryPayment does not create a Xendit invoice; it only transitions status, then redirects to checkout where initiateCheckout creates the invoice on click | initiateCheckout is the sole Xendit invoice creator per checkout README DL-002 (Xendit-first ordering invariants live there) -> creating an invoice in retryPayment would violate single-responsibility and duplicate the orphan-recovery semantics of the idempotency guard -> on retry, the previous Transaction is FAILED (not PENDING) so the initiateCheckout PENDING-Transaction idempotency guard does not fire and a fresh invoice is created naturally. This is the design intent behind the two-ID scheme (checkout DL-003): multiple Transactions per orderId is the supported retry mechanism. |
| DL-005 | Transaction.status is set to FAILED, not REFUNDED or PROCESSING, for an EXPIRED Xendit invoice | TransactionStatus enum at prisma/schema.prisma:46 has [PENDING, PROCESSING, CAPTURED, FAILED, REFUNDED] -> FAILED is the only non-success state for an attempt that never captured -> EXPIRED Xendit invoices are payment attempts that did not complete, semantically distinct from REFUNDED (which implies a successful capture was reversed). Transaction.failureReason field (schema:252) stores the human-readable reason Xendit invoice EXPIRED for audit/debugging. |
| DL-006 | Integration tests for processPaymentFailed live alongside the existing webhook integration tests in __tests__/handlers.test.ts; rollback test extends handlers-rollback.test.ts | The webhook slice has the only test files in the codebase (handlers.test.ts uses real test DB; handlers-rollback.test.ts uses full Prisma mocks) -> the new handler exercises the same atomicity invariants -> co-locating tests with the existing pattern keeps the cleanup() helper, seedBase() helper, and test fixture IDs shared, and the test runner already knows about the suite. Three scenarios: PENDING transaction transitions to FAILED and Order to PAYMENT_FAILED; idempotency — already-FAILED transaction is a no-op; rollback — order.update throw inside the $transaction propagates. |
| DL-007 | The EXPIRED-handler updates Order.status directly inside processPaymentFailed; no fan-out to a handle-payment-failed/ slice as the capture path does | processPaymentCapture fans out to handlers in orders (status advance) AND wallets (credit pending balance) — two slices touched -> processPaymentFailed touches only Order.status and Transaction.status (no wallet credit on a failed payment) -> a one-slice fan-out is overhead with no readers. Keeping the failure path inline in handlers.ts matches its actual coupling shape. handle-payment-captured/ exists because LabWallet crediting is a second slice; no analogous second slice exists for failure. |
| DL-008 | Payment method is not set on retry; ClientProfile is reused unchanged across all retries | Order.paymentMethod is written by handlePaymentCaptured from event.paymentMethod (only known after Xendit confirms which method was used) -> on retry the field stays null until the next successful capture -> no schema change. ClientProfile is a one-to-one snapshot persisted at order creation; the same email and contact details are reused for every retry invoice, which matches the single-payer semantics of an order. |
| DL-009 | Status dispatch normalizes payload.status to uppercase before switching; unmatched non-empty statuses log + acknowledge (200 received:true); empty/missing status throws to roll back and trigger Xendit retry | Xendit invoice webhook docs list status values as PAID and EXPIRED (uppercase) but field is a String, not an enum -> a defensive uppercase normalization before dispatch eliminates a class of silent-drop bugs if Xendit ever changes casing -> empty/null status is a malformed payload and must surface (throw) so Xendit retries and the integrator is alerted, not silently dropped. The route.ts switch becomes the only place that interprets payload.status; processPaymentFailed stores the original payload.status verbatim in failureReason for forensic clarity. |
| DL-010 | T-08 owns both the app router mount at /dashboard/orders/[orderId]/pay AND the acceptQuote redirect-target fix; rejected splitting these into a dedicated infrastructure-fix ticket | Steelman for separate infra ticket: keeps T-08 scope crisp (webhook + retry UI only) and isolates router-mount changes for an infrastructure-focused reviewer. Counter: either bug in isolation leaves the retry feature non-functional -> shipping mount without acceptQuote fix means CLIENTs still hit 404 from accept-quote path discovered during T-07 testing; shipping fix without mount means retryPayment redirects to the same 404 -> a separate infra-fix ticket would force T-08 to depend on it (sequencing overhead, two PRs, two CodeRabbit cycles) and the two bugs share a single root cause (canonical checkout route undocumented in app router) and a single user-visible failure (retry/accept lands on 404). The combined change is <10 lines across 2 files and shares the same acceptance criterion (checkout route reachable from both retry and accept-quote paths). Therefore folding both into T-08 minimizes PR overhead with no architectural cost. This decision is the rationale backing context.json constraints 7 and 8 (acceptQuote redirect fix; app router mount creation). |
| DL-011 | Webhook handlers log at three checkpoints: receipt (payload.id + status), dispatch decision (handler called or acknowledged-without-processing), and early-return reasons (orphan, idempotency); logger is console.info (project has no logging library yet) | processPaymentCapture and the new processPaymentFailed have multiple silent early-return paths (orphan tolerance, idempotency-by-terminal-status, status-other-than-PAID/EXPIRED) -> in production these are indistinguishable from undelivered webhooks without observability -> three log lines per request gives ops a complete trace without adding a logging dependency. console.info is the established pattern in this codebase for now; a future logging-library ticket can sweep the call sites. |
| DL-012 | Xendit invoice webhook payload.status string value EXPIRED (uppercase, exact match) is canonical for failed/expired invoices | Premise 1: Xendit official invoice webhook docs at https://docs.xendit.co/xeninvoice/invoice-callback document status values PAID, EXPIRED, PENDING as uppercase string literals on the invoice webhook payload. Premise 2: In-repo prior-art doc docs/research/Payment-Processor-eval-PipetGo.md:25 explicitly enumerates EXPIRED as the failed-invoice status string handled by the existing webhook codebase (PipetGo V1 pattern carried into V2). Premise 3: Existing route.ts:38 comment also references EXPIRED as a documented Xendit non-PAID status. Implication: The exact string EXPIRED (uppercase) is the documented contract; the DL-009 uppercase normalization is defensive against future Xendit casing drift but the design case is the documented uppercase form. Conclusion: route.ts switch case "EXPIRED" dispatching to processPaymentFailed is grounded in both upstream Xendit docs and in-repo prior art, not a fresh assumption. This DL is the citation anchor for planning_context.assumptions[0]. |
| DL-013 | T-08 owns the missing app router mount at src/app/dashboard/orders/[orderId]/pay/page.tsx and the acceptQuote redirect-target fix (from /checkout/${orderId} to /dashboard/orders/${orderId}/pay); rejected deferring these to a separate infrastructure-fix ticket. | Both changes are necessary prerequisites for any T-08 user path to succeed: retryPayment redirects to /dashboard/orders/${orderId}/pay (the checkout route), so the mount must exist before T-08 ships; acceptQuote (T-07) already redirects to the same missing /checkout/ path, meaning CLIENTs who accepted a quote before T-08 land on 404. A separate infra ticket would (a) block T-08 on that ticket closing, adding sequencing overhead and two CodeRabbit cycles, and (b) leave the checkout flow broken in production from the moment T-07 shipped until the infra ticket merged. The mount is a single thin re-export file (one line); the redirect fix is one string change in action.ts. Both share a single root cause (checkout canonical route /dashboard/orders/[orderId]/pay has no app router mount) and a single acceptance criterion (checkout route reachable from both retry and accept-quote paths). Folding into T-08 is the minimum-overhead fix with no architectural cost. This is the scope-ownership rationale that context.json constraints 7 and 8 assert as requirements. |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Create a separate retry-payment/ slice that owns the PAYMENT_FAILED page | PAYMENT_FAILED renders the same order summary, contact details, and status timeline as every other status (just with an extra action card). A separate slice would either duplicate the base rendering or import order-detail/page.tsx — the latter is an ADR-001 cross-slice violation. Inline action follows the T-07 D3 precedent. (ref: DL-002) |
| Poll for PAYMENT_FAILED status from the client instead of handling the EXPIRED webhook | Webhook is already wired and authenticated; polling adds latency, load, and a second source of truth for status. Xendit's EXPIRED event is the canonical signal. (ref: DL-001) |
| Handle the EXPIRED case in the checkout action (initiateCheckout detects an expired Transaction and flips Order.status itself) | Violates checkout invariant DL-007 (the checkout action never mutates Order.status; that is webhook-only). Also leaves orders stuck in PAYMENT_PENDING forever when the client never returns to the checkout page. (ref: DL-001) |
| Retain acceptQuote's existing /checkout/[orderId] redirect and add a /checkout/[orderId] app router mount | The checkout slice's page.tsx file-level comment documents its canonical route as /dashboard/orders/[orderId]/pay. Mounting a second route for the same slice produces two URLs for one page and complicates future dashboard routing. The one-line acceptQuote fix is simpler and preserves the canonical route. (ref: DL-003) |
| Fan out the EXPIRED path through a handle-payment-failed/ slice mirroring handle-payment-captured/ | handle-payment-captured/ exists because payment capture touches two slices (orders for status, wallets for LabWallet credit). Payment failure touches only one slice (order status); a fan-out wrapper is overhead with no readers. (ref: DL-007) |
| Mark Transaction.status as REFUNDED on Xendit EXPIRED | REFUNDED semantically implies a successful capture was reversed (TransactionStatus has CAPTURED → REFUNDED as the lifecycle pair). An EXPIRED invoice never captured, so FAILED is the correct terminal state. (ref: DL-005) |

### Constraints

- isValidStatusTransition() called before every Order.status write (project invariant — README.md, ADR-001).
- All Order.status writes inside prisma.$transaction with TOCTOU ownership re-check inside the transaction for CLIENT actions.
- redirect() never inside try/catch — Next.js throws NEXT_REDIRECT internally; catching swallows the redirect.
- No Prisma.Decimal or Date in DTOs — all RSC-to-client props are primitives.
- Xendit webhook handlers must be idempotent — terminal-status guard inside the $transaction (matches processPaymentCapture).
- Transaction.provider is the string literal 'xendit' (String column, not enum).
- retryPayment redirects to /dashboard/orders/[orderId]/pay; acceptQuote redirects to the same path (canonical checkout route).
- Webhook handlers must run all writes inside one $transaction — error rolls back all writes and returns 500 so Xendit retries.
- Unhandled states throw (CLAUDE.md Implementation Discipline): isValidStatusTransition failure inside processPaymentFailed throws, not returns.
- Webhook handlers must console.info at three checkpoints: receipt (payload.id + status), dispatch decision (handler called or acknowledged-without-processing), and early-return reasons (orphan tolerance, idempotency). This makes the silent paths observable in production (ref: DL-011).

### Known Risks

- **Concurrent EXPIRED webhook deliveries arrive simultaneously for the same Transaction; without idempotency the Order is written twice and the Transaction.failureReason flutters.**: Idempotency guard (Transaction.status === FAILED → return) is inside the $transaction boundary, matching processPaymentCapture's pattern. The first delivery commits FAILED; the second observes FAILED inside its own transaction and exits.
- **Xendit sends EXPIRED after the order has already moved past PAYMENT_PENDING (e.g. the user paid via a different invoice and the order is ACKNOWLEDGED). isValidStatusTransition returns false, the handler throws, the $transaction rolls back, response is 500, Xendit retries forever.**: Two-part mitigation: (1) the state-machine throw is the canonical Compounding-Protocol pattern (CLAUDE.md: unhandled states must throw); silencing would corrupt state. (2) Operational runbook: route.ts emits console.info on every webhook dispatch including orphan and idempotency early-returns (DL-011); ops monitors for repeat 500s on the same payload.id (signal: > 3 consecutive Xendit retries for the same invoice id within 1h) and manually marks the Transaction FAILED via a database fix so Xendit acknowledges the next retry. The alerting threshold + manual-fix runbook is captured as a follow-up ticket placeholder (T-08-OPS) tracked in the slice CLAUDE.md until the observability milestone (T-12 or later) automates it.
- **Client double-clicks Retry Payment; the second action runs while the first is mid-transaction.**: isValidStatusTransition(PAYMENT_PENDING, PAYMENT_PENDING) returns false → action returns error state; or the first action commits and the second sees PAYMENT_PENDING and errors. Either path is safe.
- **On retry, initiateCheckout's idempotency guard (lookup for PENDING Transaction by orderId) finds the old PENDING transaction if processPaymentFailed never ran — the client gets redirected to the old expired Xendit URL.**: processPaymentFailed sets Transaction.status to FAILED before allowing the Order to revert to PAYMENT_PENDING. Because retryPayment runs only after the webhook has flipped the Order to PAYMENT_FAILED, the previous Transaction is already FAILED by then. The idempotency guard at checkout/action.ts filters by status=PENDING and correctly skips the FAILED row.
- **An EXPIRED webhook arrives before our Transaction.create commit (race: Xendit invoice creation succeeded, our local Transaction write is still pending). processPaymentFailed's findFirst returns null and the EXPIRED event is silently dropped while the Order is stuck PAYMENT_PENDING.**: checkout/action.ts uses sequential await: line 88 awaits createXenditInvoice, then line 96 awaits prisma.transaction.create. The local write happens within milliseconds of the Xendit response. Xendit's invoice expiry is hours-to-days, so the race window (milliseconds-after-Xendit-response-and-before-Transaction-commit) is bounded by the two-await sequence and is operationally zero. The orphan-tolerance return is the documented behavior of processPaymentCapture and is retained for parity; if it ever fires for EXPIRED in practice, the order's quotedPrice is still valid and a manual support intervention can mark it FAILED.
- **An EXPIRED webhook arrives for an Order in a non-PAYMENT_PENDING terminal state other than ACKNOWLEDGED — specifically CANCELLED (most operationally likely: client cancelled before Xendit invoice expired) or COMPLETED (rare but possible: order completed via a different Transaction). isValidStatusTransition returns false, the handler throws, the $transaction rolls back, response is 500, Xendit retries forever for these terminal states too.**: Same accepted-risk + runbook pattern as R-002: throw-on-bad-edge is canonical; ops monitors repeat 500s and manually marks the orphan Transaction FAILED to halt Xendit retries. The CANCELLED case is the operationally likely one (client clicked Cancel after Xendit invoice was already issued); the COMPLETED case requires a second-Transaction-captured-first race that is rare. Both are captured by the same console.info log surface (DL-011) so the same alert covers them.
- **Xendit sends both EXPIRED and PAID for the same invoice with near-simultaneous delivery (reorderable in transit). If EXPIRED commits first: Transaction is FAILED, Order is PAYMENT_FAILED; subsequent PAID handler does findFirst on externalId, sees Transaction in FAILED state (not PENDING), and processPaymentCapture's existing idempotency guard (Transaction already terminal) takes a path that either (a) acknowledges as no-op or (b) attempts to write CAPTURED over FAILED. If PAID commits first: Transaction is CAPTURED, Order is ACKNOWLEDGED; subsequent EXPIRED triggers R-002/R-006. The same-invoice mixed-status race is undocumented in R-001 (which covers same-status only).**: processPaymentCapture's idempotency guard checks Transaction.status === CAPTURED and early-returns; it does NOT currently check FAILED. Required addition (in-scope for T-08): in processPaymentCapture, if transaction.status === FAILED then console.info (`[processPaymentCapture] received PAID for FAILED transaction id=${payload.id}`) and throw new Error so the $transaction rolls back and Xendit retries; ops runbook (DL-011) triages by checking whether the EXPIRED was authoritative (almost always yes per Xendit semantics — once an invoice is EXPIRED Xendit will not actually capture a payment for it; EXPIRED-then-PAID is a delivery artifact, not a real second event). This makes the race observable rather than silently corrupting state.

## Invisible Knowledge

### System

Xendit invoice webhook is the SOLE mutator of Order.status from PAYMENT_PENDING -> PAYMENT_FAILED and PAYMENT_PENDING -> ACKNOWLEDGED (DL-007 in checkout README). Server actions never mutate Order.status from a payment-pending state; the action layer only transitions PAYMENT_FAILED -> PAYMENT_PENDING (retryPayment) which is a client-initiated retry, not a payment-state mutation. This invariant means: (a) any "Order stuck in PAYMENT_PENDING" bug is a webhook-handler bug, never an action bug; (b) processPaymentCapture and processPaymentFailed are the two surfaces where payment-state correctness lives; (c) future payment-provider migrations must preserve this single-mutator property — adding a second mutation site (e.g. a poll-based status checker that flips PAYMENT_PENDING -> PAYMENT_FAILED on timeout) would break idempotency guarantees because the two mutators could race. The Transaction row uses a two-ID scheme (DL-003 checkout README): Transaction.id is our cuid, sent to Xendit as external_id; Transaction.externalId stores Xendit's returned invoice ID and is the join key for webhook dispatch. Multiple Transactions per orderId is by design — retry creates a new Transaction row, never mutates the previous one.

### Invariants

- Idempotency-by-terminal-status: every webhook handler must early-return if the Transaction is already in its target terminal state (CAPTURED for processPaymentCapture, FAILED for processPaymentFailed). The check sits INSIDE the $transaction so concurrent webhook deliveries observe each other's commits.
- Xendit-first ordering (checkout DL-002): the checkout action calls Xendit BEFORE the Prisma Transaction.create write. Consequence: a race window of milliseconds exists where Xendit could send EXPIRED for an invoice whose local Transaction row does not yet exist. processPaymentFailed must tolerate this via the findFirst-returns-null early-return (orphan tolerance).
- Two-ID scheme (checkout DL-003): Transaction.id is our pre-generated cuid sent as Xendit external_id; Transaction.externalId stores the Xendit-returned invoice ID. Webhook handlers join on externalId, never on id. Multiple Transactions per orderId is the supported retry mechanism — never UPDATE an old Transaction to create a retry.
- Webhook handlers are the SOLE mutators of Order.status from PAYMENT_PENDING (DL-007 checkout README). Server actions never write Order.status from PAYMENT_PENDING. retryPayment (PAYMENT_FAILED -> PAYMENT_PENDING) is a different state edge owned by the client and does not violate this invariant.
- ClientProfile snapshot is immutable across retries: the row created during order submission persists unchanged through all PAYMENT_PENDING -> PAYMENT_FAILED -> PAYMENT_PENDING -> ... cycles. retryPayment does not write ClientProfile; initiateCheckout reuses the existing snapshot for every retry invoice. This matches the single-payer semantics of an order and avoids contact-info drift between attempts.
- isValidStatusTransition is the only mechanism for guarding Order.status writes (project invariant, README.md + ADR-001). Both webhook handlers and server actions must call it before every update; failure throws (CLAUDE.md unhandled-states-must-throw) rather than returning silently.
- Status string contract: payload.status arrives as a String column from Xendit (PAID, EXPIRED are the documented values). route.ts normalizes to uppercase before dispatch (DL-009) so a casing drift from Xendit does not silently drop events; empty/missing status throws so the integrator is alerted, not silenced.

### Tradeoffs

- Inline retry action on order-detail/ slice (RA-001 rejected separate retry-payment/ slice). Tradeoff: inline action panel keeps base-page rendering in one place at the cost of order-detail/ growing more action surfaces over time. Rejected slice-split because PAYMENT_FAILED renders identical content to all other statuses plus one action card; a dispatcher slice would either duplicate rendering or import order-detail/page.tsx (ADR-001 cross-slice violation).
- Webhook-driven failure detection (RA-002 rejected client polling). Tradeoff: webhook couples failure detection to Xendit reliability but avoids latency, load, and a second source of truth. The auth and rate-limit infrastructure already exists for webhooks; polling would need parallel infrastructure.
- Webhook-only Order.status mutation (RA-003 rejected action-layer EXPIRED handling). Tradeoff: orders stuck PAYMENT_PENDING forever when Xendit never sends EXPIRED is a real failure mode, but moving the mutation to the action layer would break DL-007 (checkout README) — Order.status is webhook-only. The mitigation is monitoring (R-002 escalation runbook), not duplicating the mutation surface.
- Inline failure path (DL-007 rejected handle-payment-failed/ fan-out slice). Tradeoff: the capture path uses a fan-out slice because LabWallet crediting is a second slice concern; the failure path has no second concern (no wallet credit, no second reader) so fan-out would be overhead. If a future requirement (e.g. emit a PaymentFailed domain event) adds a second reader, the fan-out wrapper can be introduced then without disrupting existing callers — the throw-on-bad-edge contract makes the call boundary explicit.
- Defensive uppercase normalization + log-and-acknowledge for unknown statuses (DL-009). Tradeoff: throw-on-bad-edge is the project default for state-machine violations, but throwing on unknown Xendit statuses would cause Xendit to retry forever on any future status string we have not yet adopted (e.g. a new VOIDED status). Acknowledge-without-processing with a log line is the documented escape hatch; the log surface alerts ops to triage and add a handler. Only empty/missing payload.status throws (malformed payload, not unknown status).

## Milestones

### Milestone 1: Xendit EXPIRED webhook handler

**Files**: src/features/payments/webhooks/route.ts, src/features/payments/webhooks/handlers.ts, src/features/payments/webhooks/__tests__/handlers.test.ts, src/features/payments/webhooks/__tests__/handlers-rollback.test.ts, src/features/payments/webhooks/README.md, src/features/payments/webhooks/CLAUDE.md

**Requirements**:

- Xendit EXPIRED webhook payloads dispatch to a new processPaymentFailed handler that runs all DB writes inside a single prisma.$transaction|processPaymentFailed marks the Transaction row FAILED and writes failureReason then transitions Order from PAYMENT_PENDING to PAYMENT_FAILED via isValidStatusTransition|processPaymentFailed is orphan-tolerant (no Transaction matching externalId returns early) and idempotent (Transaction already FAILED returns early)|Any throw inside the $transaction (invalid status edge
- order missing) rolls back all writes and propagates a 500 to trigger Xendit retry

**Acceptance Criteria**:

- An EXPIRED Xendit webhook for an order in PAYMENT_PENDING with a PENDING Transaction matching the payload externalId leaves the Transaction in FAILED state with failureReason set and the Order in PAYMENT_FAILED|An EXPIRED Xendit webhook for a Transaction already in FAILED state is a no-op (Order.status and Transaction fields unchanged)|An EXPIRED Xendit webhook with no matching Transaction (payload.id unknown) returns 200 without raising and writes nothing|An EXPIRED Xendit webhook for an Order already past PAYMENT_PENDING (e.g. ACKNOWLEDGED) throws inside the $transaction so all writes roll back; the response is 500 and Xendit retries|npx tsc --noEmit is clean; npm test -- --run passes including the new processPaymentFailed scenarios
- An EXPIRED payload arriving with lowercase 'expired' or mixed-case 'Expired' is normalized to uppercase by route.ts and dispatches to processPaymentFailed identically (DL-009); a webhook payload with empty or missing payload.status causes route.ts to throw and return 500 so Xendit retries (CLAUDE.md unhandled-states-must-throw)
- Every code path in route.ts and processPaymentFailed emits a console.info log line covering: receipt, dispatch decision, and any early-return reason (orphan, idempotency); the three integration tests assert the log lines via vi.spyOn(console, 'info')
- processPaymentCapture's idempotency guard is extended to throw when transaction.status === FAILED (covers EXPIRED-then-PAID race per R-007); one new integration test in handlers.test.ts seeds a FAILED Transaction, calls processPaymentCapture with payload.status='PAID', and asserts the call throws

**Tests**:

- integration|webhooks/__tests__/handlers.test.ts|processPaymentFailed: PENDING transaction → FAILED + Order → PAYMENT_FAILED with failureReason populated
- integration|webhooks/__tests__/handlers.test.ts|processPaymentFailed idempotency: already-FAILED transaction is no-op (Order.status unchanged)
- unit-with-mocks|webhooks/__tests__/handlers-rollback.test.ts|processPaymentFailed rollback: order.update throw inside $transaction propagates and rolls back the Transaction.update

#### Code Intent

- **CI-M-001-001** `src/features/payments/webhooks/handlers.ts::processPaymentFailed`: New exported async function processPaymentFailed(payload: XenditInvoicePayload): Promise<void>. console.info(`[processPaymentFailed] enter id=${payload.id} status=${payload.status}`) at function entry (DL-011). Runs all writes inside prisma.$transaction. Inside the transaction: (1) tx.transaction.findFirst({ where: { externalId: payload.id } }) — if null, console.info(`[processPaymentFailed] orphan tolerance id=${payload.id}`) and return early (orphan tolerance, matches processPaymentCapture). (2) if transaction.status === TransactionStatus.FAILED, console.info(`[processPaymentFailed] idempotent no-op id=${payload.id}`) and return (idempotency guard inside $transaction, matches processPaymentCapture). (3) tx.transaction.update({ where: { id: transaction.id }, data: { status: TransactionStatus.FAILED, failureReason: `Xendit invoice ${payload.status}` } }) — failureReason stores the ORIGINAL payload.status string verbatim (DL-009) so forensic logs preserve the case/spelling Xendit sent; failureReason field exists on Transaction (prisma/schema.prisma:252). (4) tx.order.findUnique({ where: { id: transaction.orderId } }); if !order throw new Error with the orderId — same data-integrity pattern as processPaymentCapture line 75. (5) if !isValidStatusTransition(order.status, OrderStatus.PAYMENT_FAILED) throw new Error with from/to (CLAUDE.md unhandled-states-must-throw); this rolls back the transaction so Xendit retries — but Xendit will keep retrying for orders that are already CANCELLED, ACKNOWLEDGED, or COMPLETED (see R-002, R-006). (6) tx.order.update({ where: { id: transaction.orderId }, data: { status: OrderStatus.PAYMENT_FAILED } }) — no paidAt write, no paymentMethod write. No LabWallet write (failed payments produce no lab credit). File-level JSDoc explains the mirror relationship to processPaymentCapture and references DL-001 invariants. (refs: DL-001, DL-005, DL-007, DL-009, DL-011)
- **CI-M-001-002** `src/features/payments/webhooks/route.ts::POST`: Replace the early-return short-circuit on non-PAID payloads with an exhaustive dispatch. After token verification and JSON parse: const status = (payload.status ?? "").toUpperCase() (uppercase normalization per DL-009 — defensive against Xendit casing drift). console.info(`[webhook] received payload id=${payload.id} status=${status}`) (DL-011). If status === "" throw new Error("Xendit webhook missing payload.status") so $transaction-less route handler returns 500 and Xendit retries (CLAUDE.md unhandled-states-must-throw). switch (status) { case "PAID": console.info(`[webhook] dispatch to processPaymentCapture id=${payload.id}`); await processPaymentCapture(payload); break; case "EXPIRED": console.info(`[webhook] dispatch to processPaymentFailed id=${payload.id}`); await processPaymentFailed(payload); break; default: console.info(`[webhook] acknowledged-without-processing id=${payload.id} status=${status}`); }. Return NextResponse.json({ received: true }). Import processPaymentFailed alongside processPaymentCapture. Update the file-level comment so the description "Non-PAID payloads return 200 immediately" is corrected to reflect that EXPIRED now processes; only unrelated statuses (PENDING, intermediate) acknowledge without processing; missing/empty payload.status throws. (refs: DL-001, DL-008, DL-009, DL-011)
- **CI-M-001-003** `src/features/payments/webhooks/__tests__/handlers.test.ts::describe(processPaymentFailed)`: Add a second describe block describe(processPaymentFailed) below describe(processPaymentCapture). Reuses cleanup(), seedBase(), beforeEach, afterAll. Three tests: (1) transitions Transaction PENDING → FAILED and Order PAYMENT_PENDING → PAYMENT_FAILED — seed Order with status PAYMENT_PENDING and PENDING Transaction, call processPaymentFailed with payload.status='EXPIRED', assert testPrisma.transaction.findUnique returns FAILED status with failureReason matching /EXPIRED/, assert testPrisma.order.findUnique returns PAYMENT_FAILED. (2) idempotency: already-FAILED transaction is a no-op — seed Order with PAYMENT_FAILED and Transaction with FAILED status, call processPaymentFailed, assert both rows unchanged. (3) orphan tolerance: unknown externalId returns without error — call processPaymentFailed with payload.id not in DB, assert no throw, no row written. Reuse the TEST_ORDER_ID_1/2, TEST_TX_EXTERNAL_ID_1/2/3 constants (extend with TEST_TX_EXTERNAL_ID_4 if needed). (refs: DL-001, DL-006)
- **CI-M-001-004** `src/features/payments/webhooks/__tests__/handlers-rollback.test.ts::describe(processPaymentFailed — rollback)`: Add a second describe block at the bottom of the file. Imports processPaymentFailed. Uses a parallel mock setup: mockTxTransactionFindFirst returns a PENDING transaction; mockTxTransactionUpdate resolves; mockTxOrderFindUnique returns an order with status PAYMENT_PENDING; mockTxOrderUpdate rejects with new Error('order update failure'). Asserts await expect(processPaymentFailed(payload)).rejects.toThrow('order update failure'). Keeps the same vi.mock('@/lib/prisma') pattern. Test asserts the error propagates so Prisma rolls back the in-transaction Transaction.update. (refs: DL-001, DL-006)
- **CI-M-001-005** `src/features/payments/webhooks/README.md::documentation`: Add a section explaining processPaymentFailed as the mirror of processPaymentCapture for EXPIRED Xendit invoices: same $transaction boundary, same orphan tolerance, same idempotency-by-terminal-status pattern. Document that failureReason captures the Xendit payload.status string (e.g. 'Xendit invoice EXPIRED'). Document that no LabWallet credit occurs on failure. Document the exhaustive route.ts switch: PAID dispatches to processPaymentCapture, EXPIRED to processPaymentFailed, anything else acknowledges without processing. (refs: DL-001, DL-005, DL-008)
- **CI-M-001-006** `src/features/payments/webhooks/CLAUDE.md::documentation`: Update the Index table row for handlers.ts to mention both processPaymentCapture (PAID) and processPaymentFailed (EXPIRED). Update the row for route.ts to mention the exhaustive PAID/EXPIRED dispatch. (refs: DL-001)
- **CI-M-001-007** `src/features/payments/webhooks/handlers.ts::processPaymentCapture (guard extension)`: Extend processPaymentCapture's existing idempotency guard inside its $transaction. Currently the guard is: if (transaction.status === TransactionStatus.CAPTURED) return (no-op). Add a sibling branch: if (transaction.status === TransactionStatus.FAILED) { console.info(`[processPaymentCapture] received PAID for FAILED transaction id=${payload.id}`); throw new Error(`Refusing to capture FAILED transaction ${transaction.id}: EXPIRED already terminal`); } — this covers the R-007 EXPIRED-then-PAID race so the conflict is observable rather than silently overwriting a terminal FAILED with CAPTURED. The throw rolls back the $transaction, Xendit retries (which ops triages via the DL-011 log surface). No change to the PENDING -> CAPTURED happy path; no change to the file-level JSDoc. (refs: DL-001, DL-011)
- **CI-M-001-008** `src/features/payments/webhooks/__tests__/handlers.test.ts::describe(processPaymentCapture) — FAILED-guard test`: Add a fourth test inside the existing describe(processPaymentCapture) block (or as a new describe sibling if scoping requires): seed Order with status PAYMENT_FAILED and Transaction with status FAILED, call processPaymentCapture with payload.status='PAID' targeting that Transaction's externalId, assert await expect(...).rejects.toThrow(/FAILED/). Asserts the FAILED idempotency guard introduced in CI-M-001-007 fires. Uses the existing cleanup() and seedBase() helpers and existing test fixture IDs. (refs: DL-001, DL-011)

#### Code Changes

**CC-M-001-001** (src/features/payments/webhooks/handlers.ts) - implements CI-M-001-001

**Code:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -1,13 +1,15 @@
 /**
  * Payment capture processor for Xendit invoice webhooks.
  *
- * processPaymentCapture runs all DB writes inside a single Prisma $transaction:
- * idempotency check, Transaction update, Order status transition, and LabWallet credit are atomic.
+ * processPaymentCapture and processPaymentFailed run all DB writes inside a single Prisma $transaction.
  * Any throw at any step rolls back all writes; Xendit retries on 500 reattempt the full capture.
  * (ref: DL-001, DL-004, DL-006)
  */
-import { TransactionStatus } from '@prisma/client'
+import { OrderStatus, TransactionStatus } from '@prisma/client'
 import { prisma } from '@/lib/prisma'
 import { PaymentCapturedEvent } from '@/domain/payments/events'
 import { handlePaymentCaptured } from '@/features/orders/handle-payment-captured/handler'
+import { isValidStatusTransition } from '@/domain/orders/state-machine'
 import type { XenditInvoicePayload } from './types'
@@ -86,3 +88,52 @@ export async function processPaymentCapture(payload: XenditInvoicePayload): Pro
   })
 }
+
+/**
+ * Marks Transaction FAILED and transitions Order PAYMENT_PENDING→PAYMENT_FAILED.
+ * Mirrors processPaymentCapture: same $transaction boundary, orphan tolerance,
+ * idempotency-by-terminal-status. (ref: DL-001)
+ * No LabWallet write — failed payments produce no lab credit. (ref: DL-007)
+ */
+export async function processPaymentFailed(payload: XenditInvoicePayload): Promise<void> {
+  console.info(`[processPaymentFailed] enter id=${payload.id} status=${payload.status}`)
+
+  await prisma.$transaction(async (tx) => {
+    const transaction = await tx.transaction.findFirst({
+      where: { externalId: payload.id },
+    })
+
+    if (!transaction) {
+      console.info(`[processPaymentFailed] orphan tolerance id=${payload.id}`)
+      return
+    }
+
+    if (transaction.status === TransactionStatus.FAILED) {
+      // Idempotency guard — inside $transaction to close concurrent-delivery race. (ref: DL-004)
+      console.info(`[processPaymentFailed] idempotent no-op id=${payload.id}`)
+      return
+    }
+
+    await tx.transaction.update({
+      where: { id: transaction.id },
+      data: {
+        status: TransactionStatus.FAILED,
+        failureReason: `Xendit invoice ${payload.status}`,
+      },
+    })
+
+    const order = await tx.order.findUnique({
+      where: { id: transaction.orderId },
+    })
+
+    if (!order) {
+      throw new Error(`Order not found for orderId ${transaction.orderId} during EXPIRED processing`)
+    }
+
+    if (!isValidStatusTransition(order.status, OrderStatus.PAYMENT_FAILED)) {
+      throw new Error(`Cannot transition Order ${order.id} from ${order.status} to PAYMENT_FAILED`)
+    }
+
+    await tx.order.update({
+      where: { id: transaction.orderId },
+      data: { status: OrderStatus.PAYMENT_FAILED },
+    })
+  })
+}
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -1,8 +1,8 @@
 /**
- * Payment capture processor for Xendit invoice webhooks.
+ * Payment capture and failure processors for Xendit invoice webhooks.
  *
- * processPaymentCapture runs all DB writes inside a single Prisma $transaction:
- * idempotency check, Transaction update, Order status transition, and LabWallet credit are atomic.
+ * processPaymentCapture and processPaymentFailed run all DB writes inside a single Prisma $transaction.
  * Any throw at any step rolls back all writes; Xendit retries on 500 reattempt the full capture.
  * (ref: DL-001, DL-004, DL-006)
  */
@@ -88,4 +88,12 @@ export async function processPaymentCapture(payload: XenditInvoicePayload): Pro
 }
+
+/**
+ * Marks Transaction FAILED and transitions Order PAYMENT_PENDING→PAYMENT_FAILED.
+ * Mirrors processPaymentCapture: same $transaction boundary, orphan tolerance,
+ * idempotency-by-terminal-status. (ref: DL-001)
+ * No LabWallet write — failed payments produce no lab credit. (ref: DL-007)
+ */
+export async function processPaymentFailed(payload: XenditInvoicePayload): Promise<void> {
```


**CC-M-001-002** (src/features/payments/webhooks/handlers.ts) - implements CI-M-001-007

**Code:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -38,6 +38,12 @@ export async function processPaymentCapture(payload: XenditInvoicePayload): Pro
     if (transaction.status === TransactionStatus.CAPTURED) {
       // Idempotency guard — inside $transaction to close concurrent-delivery race. (ref: DL-004)
       return
     }
+
+    if (transaction.status === TransactionStatus.FAILED) {
+      // EXPIRED-then-PAID concurrent delivery: refuse to overwrite terminal FAILED with CAPTURED. (ref: R-007)
+      console.info(`[processPaymentCapture] received PAID for FAILED transaction id=${payload.id}`)
+      throw new Error(`Refusing to capture FAILED transaction ${transaction.id}: EXPIRED already terminal`)
+    }

     const capturedAt = new Date()
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -38,6 +38,8 @@ export async function processPaymentCapture(payload: XenditInvoicePayload): Pro
     if (transaction.status === TransactionStatus.CAPTURED) {
       // Idempotency guard — inside $transaction to close concurrent-delivery race. (ref: DL-004)
       return
     }
+
+    if (transaction.status === TransactionStatus.FAILED) {
+      // EXPIRED-then-PAID concurrent delivery: refuse to overwrite terminal FAILED with CAPTURED. (ref: R-007)
```


**CC-M-001-003** (src/features/payments/webhooks/route.ts) - implements CI-M-001-002

**Code:**

```diff
--- a/src/features/payments/webhooks/route.ts
+++ b/src/features/payments/webhooks/route.ts
@@ -3,8 +3,8 @@
  *
  * Authenticates via x-callback-token header (static token, not HMAC).
- * Non-PAID payloads return 200 immediately — Xendit expects acknowledgement for
- * all delivery attempts regardless of business relevance. (ref: DL-002, DL-006)
+ * PAID dispatches to processPaymentCapture; EXPIRED to processPaymentFailed.
+ * Unknown statuses are acknowledged without processing; missing status throws. (ref: DL-009)
  *
  * $transaction errors propagate as 500 to trigger Xendit's automatic retry.
  * No auth() call — webhook is server-to-server; token header is the only credential. (ref: DL-007)
@@ -11,8 +11,8 @@ import { NextRequest, NextResponse } from 'next/server'
 import crypto from 'crypto'
-import { processPaymentCapture } from './handlers'
+import { processPaymentCapture, processPaymentFailed } from './handlers'
 import type { XenditInvoicePayload } from './types'
@@ -35,12 +35,23 @@ export async function POST(req: NextRequest): Promise<NextResponse> {

   const payload = (await req.json()) as XenditInvoicePayload

-  // Acknowledge non-PAID events without processing — Xendit sends PENDING, EXPIRED etc. (ref: DL-006)
-  if (payload.status !== 'PAID') {
-    return NextResponse.json({ received: true })
+  const status = (payload.status ?? '').toUpperCase()
+  console.info(`[webhook] received payload id=${payload.id} status=${status}`)
+
+  if (status === '') {
+    throw new Error('Xendit webhook missing payload.status')
   }

-  await processPaymentCapture(payload)
+  switch (status) {
+    case 'PAID':
+      console.info(`[webhook] dispatch to processPaymentCapture id=${payload.id}`)
+      await processPaymentCapture(payload)
+      break
+    case 'EXPIRED':
+      console.info(`[webhook] dispatch to processPaymentFailed id=${payload.id}`)
+      await processPaymentFailed(payload)
+      break
+    default:
+      console.info(`[webhook] acknowledged-without-processing id=${payload.id} status=${status}`)
+  }

   return NextResponse.json({ received: true })
 }
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/route.ts
+++ b/src/features/payments/webhooks/route.ts
@@ -3,8 +3,8 @@
  *
  * Authenticates via x-callback-token header (static token, not HMAC).
- * Non-PAID payloads return 200 immediately — Xendit expects acknowledgement for
- * all delivery attempts regardless of business relevance. (ref: DL-002, DL-006)
+ * PAID dispatches to processPaymentCapture; EXPIRED to processPaymentFailed.
+ * Unknown statuses are acknowledged without processing; missing status throws. (ref: DL-009)
  *
  * $transaction errors propagate as 500 to trigger Xendit's automatic retry.
  * No auth() call — webhook is server-to-server; token header is the only credential. (ref: DL-007)
  */
```


**CC-M-001-004** (src/features/payments/webhooks/__tests__/handlers.test.ts) - implements CI-M-001-003

**Code:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -3,7 +3,7 @@ import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode } from '@prisma/client'
 import { testPrisma } from '@/test/test-prisma'
-import { processPaymentCapture } from '../handlers'
+import { processPaymentCapture, processPaymentFailed } from '../handlers'
 import type { XenditInvoicePayload } from '../types'
@@ -17,6 +17,7 @@ const TEST_ORDER_ID_2 = 'test-order-2'
 const TEST_TX_EXTERNAL_ID_1 = 'xendit-test-ext-1'
 const TEST_TX_EXTERNAL_ID_2 = 'xendit-test-ext-2'
 const TEST_TX_EXTERNAL_ID_3 = 'xendit-test-ext-3'
+const TEST_TX_EXTERNAL_ID_4 = 'xendit-test-ext-4'

 async function cleanup() {
   await testPrisma.labWallet.deleteMany({ where: { labId: TEST_LAB_ID } })
@@ -24,8 +24,8 @@ async function cleanup() {
   await testPrisma.transaction.deleteMany({
     where: {
       externalId: {
-        in: [TEST_TX_EXTERNAL_ID_1, TEST_TX_EXTERNAL_ID_2, TEST_TX_EXTERNAL_ID_3],
+        in: [TEST_TX_EXTERNAL_ID_1, TEST_TX_EXTERNAL_ID_2, TEST_TX_EXTERNAL_ID_3, TEST_TX_EXTERNAL_ID_4],
       },
     },
   })
@@ -185,3 +185,84 @@ describe('processPaymentCapture', () => {
   })
 })
+
+describe('processPaymentFailed', () => {
+  it('marks Transaction FAILED and transitions Order to PAYMENT_FAILED', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_1,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.PAYMENT_PENDING,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-failed-1',
+        orderId: TEST_ORDER_ID_1,
+        externalId: TEST_TX_EXTERNAL_ID_4,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.PENDING,
+      },
+    })
+
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_4,
+      status: 'EXPIRED',
+      paid_amount: 0,
+      payer_email: 'client@test.local',
+    }
+
+    await processPaymentFailed(payload)
+
+    const tx = await testPrisma.transaction.findFirst({ where: { externalId: TEST_TX_EXTERNAL_ID_4 } })
+    expect(tx!.status).toBe(TransactionStatus.FAILED)
+    expect(tx!.failureReason).toMatch(/EXPIRED/)
+    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_1 } })
+    expect(order!.status).toBe(OrderStatus.PAYMENT_FAILED)
+  })
+
+  it('is a no-op when Transaction is already FAILED (idempotency)', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_1,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.PAYMENT_FAILED,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-failed-2',
+        orderId: TEST_ORDER_ID_1,
+        externalId: TEST_TX_EXTERNAL_ID_4,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.FAILED,
+        failureReason: 'Xendit invoice EXPIRED',
+      },
+    })
+
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_4,
+      status: 'EXPIRED',
+      paid_amount: 0,
+      payer_email: 'client@test.local',
+    }
+
+    await processPaymentFailed(payload)
+
+    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_1 } })
+    expect(order!.status).toBe(OrderStatus.PAYMENT_FAILED)
+  })
+
+  it('returns without error when Transaction is not found (orphan tolerance)', async () => {
+    const payload: XenditInvoicePayload = {
+      id: 'xendit-unknown-ext-id',
+      status: 'EXPIRED',
+      paid_amount: 0,
+      payer_email: 'client@test.local',
+    }
+
+    await expect(processPaymentFailed(payload)).resolves.not.toThrow()
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -185,3 +185,6 @@ describe('processPaymentCapture', () => {
   })
 })
+
+describe('processPaymentFailed', () => {
+  // Tests: PENDING→FAILED transition, idempotency (already-FAILED no-op), orphan tolerance.
```


**CC-M-001-005** (src/features/payments/webhooks/__tests__/handlers.test.ts) - implements CI-M-001-008

**Code:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -180,5 +180,37 @@ describe('processPaymentCapture', () => {
     const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
     expect(wallet).toBeNull()
   })
+
+  it('throws when Transaction is already FAILED (EXPIRED-then-PAID race, ref: R-007)', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_1,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.PAYMENT_FAILED,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-failed-guard',
+        orderId: TEST_ORDER_ID_1,
+        externalId: TEST_TX_EXTERNAL_ID_4,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.FAILED,
+        failureReason: 'Xendit invoice EXPIRED',
+      },
+    })
+
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_4,
+      status: 'PAID',
+      paid_amount: 1500,
+      payer_email: 'client@test.local',
+    }
+
+    await expect(processPaymentCapture(payload)).rejects.toThrow(/FAILED/)
+  })
 })
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/README.md
+++ b/src/features/payments/webhooks/README.md
@@ -10,7 +10,10 @@
 2. `route.ts` verifies `x-callback-token` header against `XENDIT_WEBHOOK_TOKEN`
    env var using `crypto.timingSafeEqual`. Returns 401 on mismatch.
-3. Non-`PAID` status values return 200 immediately (no-op acknowledgement).
+3. `route.ts` normalises `payload.status` to uppercase and dispatches:
+   - `PAID` → `processPaymentCapture`
+   - `EXPIRED` → `processPaymentFailed`
+   - Other non-empty statuses → acknowledged without processing (200, no DB write)
+   - Empty/missing status → throws (500) so Xendit retries
```


**CC-M-001-006** (src/features/payments/webhooks/__tests__/handlers-rollback.test.ts) - implements CI-M-001-004

**Code:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
@@ -1,6 +1,6 @@
 import { describe, it, expect, vi } from 'vitest'
 import { Decimal } from '@prisma/client/runtime/library'
-import { TransactionStatus } from '@prisma/client'
+import { OrderStatus, TransactionStatus } from '@prisma/client'

 const mockTxUpdate = vi.fn().mockResolvedValue({})
-const mockTxOrderFindUnique = vi.fn().mockResolvedValue({ labId: 'mock-lab-id' })
+const mockTxOrderFindUnique = vi.fn().mockResolvedValue({ id: 'mock-order-id', labId: 'mock-lab-id', status: OrderStatus.PAYMENT_PENDING })
+const mockTxOrderUpdate = vi.fn().mockRejectedValue(new Error('order update failure'))
 const mockTxLabWalletUpsert = vi.fn().mockRejectedValue(new Error('wallet failure'))
 const mockTxTransactionFindFirst = vi.fn().mockResolvedValue({
@@ -18,6 +18,7 @@ const mockTx = {
   order: {
     findUnique: mockTxOrderFindUnique,
+    update: mockTxOrderUpdate,
   },
   labWallet: {
     upsert: mockTxLabWalletUpsert,
@@ -30,7 +31,8 @@ vi.mock('@/lib/prisma', () => ({
 vi.mock('@/features/orders/handle-payment-captured/handler', () => ({
   handlePaymentCaptured: vi.fn().mockResolvedValue(undefined),
 }))
+vi.mock('@/domain/orders/state-machine', () => ({
+  isValidStatusTransition: vi.fn().mockReturnValue(true),
+}))

-import { processPaymentCapture } from '../handlers'
+import { processPaymentCapture, processPaymentFailed } from '../handlers'
 import type { XenditInvoicePayload } from '../types'
@@ -50,3 +52,19 @@ describe('processPaymentCapture — rollback error propagation', () => {
     await expect(processPaymentCapture(payload)).rejects.toThrow('wallet failure')
   })
 })
+
+describe('processPaymentFailed — rollback error propagation', () => {
+  it('rejects when order.update throws, confirming error propagation triggers Prisma rollback', async () => {
+    const payload: XenditInvoicePayload = {
+      id: 'xendit-mock-ext',
+      status: 'EXPIRED',
+      paid_amount: 0,
+      payer_email: 'client@test.local',
+    }
+
+    await expect(processPaymentFailed(payload)).rejects.toThrow('order update failure')
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/CLAUDE.md
+++ b/src/features/payments/webhooks/CLAUDE.md
@@ -5,8 +5,8 @@
 | File          | Contents (WHAT)                                                                                  | Read When (WHEN)                                              |
 | ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
-| `route.ts`    | Next.js route handler; x-callback-token verification; status filtering                          | Modifying webhook auth or adding new Xendit event types       |
-| `handlers.ts` | `processPaymentCapture` — Transaction CAPTURED update, Order fan-out, LabWallet credit (atomic) | Modifying payment capture logic or LabWallet crediting        |
+| `route.ts`    | Next.js route handler; x-callback-token verification; exhaustive PAID/EXPIRED dispatch          | Modifying webhook auth or adding new Xendit event types       |
+| `handlers.ts` | `processPaymentCapture` (PAID) and `processPaymentFailed` (EXPIRED) — atomic Transaction+Order writes | Modifying payment capture or failure logic |
```


**CC-M-001-007** (src/features/payments/webhooks/README.md) - implements CI-M-001-005

**Code:**

```diff
--- a/src/features/payments/webhooks/README.md
+++ b/src/features/payments/webhooks/README.md
@@ -10,7 +10,10 @@
 2. `route.ts` verifies `x-callback-token` header against `XENDIT_WEBHOOK_TOKEN`
    env var using `crypto.timingSafeEqual`. Returns 401 on mismatch.
-3. Non-`PAID` status values return 200 immediately (no-op acknowledgement).
-4. `handlers.ts:processPaymentCapture` runs a Prisma `$transaction`:
+3. `route.ts` normalises `payload.status` to uppercase and dispatches:
+   - `PAID` → `processPaymentCapture`
+   - `EXPIRED` → `processPaymentFailed`
+   - Other non-empty statuses → acknowledged without processing (200, no DB write)
+   - Empty/missing status → throws (500) so Xendit retries
+4. `handlers.ts:processPaymentCapture` runs a Prisma `$transaction` (PAID path):
    - Finds `Transaction` by `Transaction.externalId == payload.id`.
-   - Returns early if not found (orphan tolerance) or already `CAPTURED` (idempotency).
+   - Returns early if not found (orphan tolerance) or already `CAPTURED` (idempotency). Throws if `FAILED` (EXPIRED-then-PAID race guard, ref: R-007).
    - Updates `Transaction` to `CAPTURED`, sets `capturedAt`.
    - Constructs `PaymentCapturedEvent` and calls `handlePaymentCaptured` from the
      orders slice inside the same transaction.
    - Fetches `Order.labId` (read-consistent within same transaction). (ref: DL-004)
    - Upserts `LabWallet.pendingBalance += Transaction.amount` (Decimal, not payload float) for the lab. (ref: DL-002, DL-003, DL-005)
+5. `handlers.ts:processPaymentFailed` runs a Prisma `$transaction` (EXPIRED path):
+   - Finds `Transaction` by `Transaction.externalId == payload.id`.
+   - Returns early if not found (orphan tolerance) or already `FAILED` (idempotency).
+   - Updates `Transaction` to `FAILED`, sets `failureReason = 'Xendit invoice EXPIRED'`.
+   - Transitions `Order.status` from `PAYMENT_PENDING` to `PAYMENT_FAILED` via `isValidStatusTransition`.
+   - No `LabWallet` write — failed payments produce no lab credit.
 5. `$transaction` errors propagate as 500 — Xendit retries on non-2xx.
-6. A Xendit retry on a previously-captured Transaction hits the `CAPTURED` guard and exits
-   before any writes, preventing double-credit of `LabWallet.pendingBalance`. (ref: DL-007)
+6. Idempotency guards for both handlers are inside their `$transaction` boundaries to prevent
+   race conditions from concurrent Xendit webhook deliveries. (ref: DL-004)
@@ -87,8 +97,16 @@ Integration tests for `processPaymentCapture` are split across two files by moc
 | File | Tests | DB strategy | Why |
 |------|-------|-------------|-----|
 | `__tests__/handlers.test.ts` | 1-3: wallet creation, balance increment, idempotency | Real test database (`DATABASE_TEST_URL`) | Financial ledger correctness requires DB-level verification — mocking hides Decimal type mismatches and FK constraint errors |
+| `__tests__/handlers.test.ts` | 4: processPaymentCapture FAILED guard (EXPIRED-then-PAID race) | Real test database | Tests the guard that throws on FAILED transaction — same real-DB rationale |
+| `__tests__/handlers.test.ts` | 5-7: processPaymentFailed transitions, idempotency, orphan tolerance | Real test database | Same rationale as above; confirms status field writes and failureReason |
 | `__tests__/handlers-rollback.test.ts` | 4: rollback error propagation | Full Prisma mock (`vi.fn()` stubs) | Forcing `tx.labWallet.upsert` to fail on a real database requires schema changes; `$transaction` atomicity is a Prisma/PostgreSQL guarantee, so this test verifies error propagation only |
+| `__tests__/handlers-rollback.test.ts` | 5: processPaymentFailed rollback | Full Prisma mock | Same rationale — forcing `tx.order.update` to fail; atomicity is a Prisma guarantee |
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -88,4 +88,14 @@ export async function processPaymentCapture(payload: XenditInvoicePayload): Pro
 }
+
+/**
+ * Marks Transaction FAILED and transitions Order PAYMENT_PENDING→PAYMENT_FAILED.
+ * Mirrors processPaymentCapture: same $transaction boundary, orphan tolerance,
+ * idempotency-by-terminal-status. (ref: DL-001)
+ * No LabWallet write — failed payments produce no lab credit. (ref: DL-007)
+ */
```


**CC-M-001-008** (src/features/payments/webhooks/CLAUDE.md) - implements CI-M-001-006

**Code:**

```diff
--- a/src/features/payments/webhooks/CLAUDE.md
+++ b/src/features/payments/webhooks/CLAUDE.md
@@ -5,8 +5,8 @@
 | File          | Contents (WHAT)                                                                                  | Read When (WHEN)                                              |
 | ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
-| `route.ts`    | Next.js route handler; x-callback-token verification; status filtering                          | Modifying webhook auth or adding new Xendit event types       |
-| `handlers.ts` | `processPaymentCapture` — Transaction CAPTURED update, Order fan-out, LabWallet credit (atomic) | Modifying payment capture logic or LabWallet crediting        |
+| `route.ts`    | Next.js route handler; x-callback-token verification; exhaustive PAID/EXPIRED dispatch          | Modifying webhook auth or adding new Xendit event types       |
+| `handlers.ts` | `processPaymentCapture` (PAID) — Transaction CAPTURED, Order fan-out, LabWallet credit; `processPaymentFailed` (EXPIRED) — Transaction FAILED, Order PAYMENT_FAILED, no wallet write | Modifying payment capture or failure logic |
 | `types.ts`    | `XenditInvoicePayload` — webhook request body shape                                              | Adding fields from Xendit payload or modifying type contracts |
 | `README.md`   | Request flow, two-ID scheme, invariants, idempotency design                                      | Understanding capture lifecycle or debugging webhook behavior |
-| `__tests__/handlers.test.ts` | processPaymentCapture integration tests (tests 1-3) — real test database: wallet creation, balance increment, idempotency | Running or modifying integration tests for payment capture |
-| `__tests__/handlers-rollback.test.ts` | processPaymentCapture rollback test (test 4) — full Prisma mock: wallet upsert failure error propagation | Running or modifying the rollback error propagation test |
+| `__tests__/handlers.test.ts` | processPaymentCapture (tests 1-4) and processPaymentFailed (tests 5-7) integration tests — real test database | Running or modifying payment handler integration tests |
+| `__tests__/handlers-rollback.test.ts` | processPaymentCapture and processPaymentFailed rollback tests — full Prisma mock: error propagation | Running or modifying rollback error propagation tests |
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -183,3 +183,6 @@ describe('processPaymentCapture', () => {
     expect(wallet).toBeNull()
   })
+
+  // EXPIRED-then-PAID race guard (ref: R-007): PAID for a FAILED transaction throws.
```


### Milestone 2: Retry UI + checkout app router mount + acceptQuote redirect fix

**Files**: src/features/orders/order-detail/action.ts, src/features/orders/order-detail/ui.tsx, src/features/orders/order-detail/page.tsx, src/features/orders/order-detail/__tests__/action.test.ts, src/features/orders/order-detail/CLAUDE.md, src/app/dashboard/orders/[orderId]/pay/page.tsx

**Requirements**:

- order-detail/action.ts exports a retryPayment server action that follows the acceptQuote pattern — auth guard
- $transaction with TOCTOU ownership re-check
- isValidStatusTransition before update
- redirect outside try/catch|order-detail/ui.tsx exports an OrderDetailRetryPayment client component using useActionState that renders a card with explanatory copy and a Retry Payment button|order-detail/page.tsx renders OrderDetailRetryPayment when dto.status === PAYMENT_FAILED|A new app router page at src/app/dashboard/orders/[orderId]/pay/page.tsx re-exports the checkout slice page so /dashboard/orders/[orderId]/pay is reachable|acceptQuote redirects to /dashboard/orders/${orderId}/pay (not /checkout/${orderId})|order-detail/CLAUDE.md documents the new action
- the new UI component
- the retry redirect target
- and the invariant that retryPayment does not create a Xendit invoice

**Acceptance Criteria**:

- A CLIENT viewing an order with status PAYMENT_FAILED sees an OrderDetailRetryPayment card with explanatory copy and a Retry Payment button|Clicking Retry Payment transitions the order to PAYMENT_PENDING and redirects the browser to /dashboard/orders/${orderId}/pay|The browser-reached /dashboard/orders/${orderId}/pay renders the checkout slice page (no 404)|Clicking Accept Quote on a QUOTE_PROVIDED order redirects to /dashboard/orders/${orderId}/pay (no 404) and renders the checkout summary|retryPayment returns the message Order not found when the CLIENT does not own the order; the Order row is unmodified|retryPayment returns the message Order cannot be retried from current status when the order is not in PAYMENT_FAILED; the Order row is unmodified|npx tsc --noEmit is clean; npm test -- --run passes

**Tests**:

- unit-with-mocks|order-detail/__tests__/action.test.ts|retryPayment auth guard: auth() null -> returns Unauthorized message and prisma not called
- unit-with-mocks|order-detail/__tests__/action.test.ts|retryPayment ownership re-check: order.clientId mismatch -> returns Order not found and order.update never called
- unit-with-mocks|order-detail/__tests__/action.test.ts|retryPayment invalid status: QUOTE_PROVIDED order -> returns Order cannot be retried message and order.update never called
- unit-with-mocks|order-detail/__tests__/action.test.ts|retryPayment happy path: PAYMENT_FAILED order -> order.update called with PAYMENT_PENDING and redirect invoked with /dashboard/orders/${orderId}/pay
- manual|browser|PAYMENT_FAILED order shows Retry Payment card; click transitions to PAYMENT_PENDING and lands on checkout page
- manual|browser|acceptQuote happy path no longer hits a 404; checkout page renders
- regression|order-detail Accept/Reject flow|QUOTE_PROVIDED order still shows OrderDetailQuoteActions and Accept lands on the checkout page

#### Code Intent

- **CI-M-002-001** `src/features/orders/order-detail/action.ts::retryPayment`: New exported async server action retryPayment(_prevState, formData): Promise<ActionState>. Follows acceptQuote pattern line-for-line. (1) Extract orderId from formData; return { message: 'Missing order ID.' } if absent. (2) const session = await auth(); return { message: 'Unauthorized.' } if !session || !session.user.id || session.user.role !== 'CLIENT'. (3) const result = await prisma.$transaction(async (tx) => { ... }): tx.order.findUnique({ where: { id: orderId } }); ownership check if !order || order.clientId !== session.user.id return { message: 'Order not found.' }; isValidStatusTransition(order.status, OrderStatus.PAYMENT_PENDING) check returning { message: 'Order cannot be retried from current status.' } on false; tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.PAYMENT_PENDING } }); return null. (4) if (result !== null) return result. (5) redirect with target /dashboard/orders/[orderId]/pay (template literal interpolating orderId) — OUTSIDE try/catch, OUTSIDE the $transaction. Also: correct acceptQuote's redirect target from /checkout/[orderId] to /dashboard/orders/[orderId]/pay (single-line edit in the same file). retryPayment does not write any Transaction row and does not call Xendit — the next initiateCheckout call from the checkout page creates the fresh invoice naturally. (refs: DL-002, DL-003, DL-004)
- **CI-M-002-002** `src/features/orders/order-detail/ui.tsx::OrderDetailRetryPayment`: New exported client component OrderDetailRetryPayment({ orderId }: { orderId: string }). Uses useActionState(retryPayment, null). Renders a Card with: explanatory copy 'Your previous payment attempt expired. Click Retry Payment to start a new payment.', a single Retry Payment Button (primary), hidden input name=orderId value={orderId}, and inline error display from action state.message. Mirrors the existing OrderDetailQuoteActions structure but with a single form and no quotedPrice prop. Import retryPayment alongside the existing acceptQuote, rejectQuote imports. (refs: DL-002)
- **CI-M-002-003** `src/features/orders/order-detail/page.tsx::OrderDetailPage`: Import OrderDetailRetryPayment from './ui' alongside the existing OrderDetailQuoteActions import. After the existing { dto.status === 'QUOTE_PROVIDED' && dto.quotedPrice != null && <OrderDetailQuoteActions ... /> } block, before the QUOTE_REJECTED card block, add: { dto.status === 'PAYMENT_FAILED' && <OrderDetailRetryPayment orderId={dto.id} /> }. No other changes. The status badge config already maps PAYMENT_FAILED; the timeline already renders the failure step (page.tsx getTimelineSteps PAYMENT_FAILED branch). (refs: DL-002)
- **CI-M-002-004** `src/app/dashboard/orders/[orderId]/pay/page.tsx::default export`: New file. Thin re-export of the checkout slice page: export { default } from '@/features/payments/checkout/page'. File-level comment mirrors the established re-export pattern at src/app/dashboard/orders/[orderId]/page.tsx — references ADR-001 VSA boundary and explains the file is a routing-only mount. (refs: DL-003)
- **CI-M-002-005** `src/features/orders/order-detail/CLAUDE.md::documentation`: Add a row to the Files table for the new retryPayment action and OrderDetailRetryPayment UI component. Add invariants to the Invariants section: (1) retryPayment does not create a Xendit invoice — it only transitions PAYMENT_FAILED to PAYMENT_PENDING and redirects to the checkout page where initiateCheckout creates the fresh invoice. (2) retryPayment's redirect target is /dashboard/orders/[orderId]/pay — the canonical checkout route mounted at src/app/dashboard/orders/[orderId]/pay/page.tsx. (3) OrderDetailRetryPayment is only rendered when dto.status === 'PAYMENT_FAILED'. (4) acceptQuote's redirect target is /dashboard/orders/[orderId]/pay (the canonical checkout route); the historical /checkout/[orderId] target referenced no mounted app router page. (refs: DL-002, DL-003, DL-004)
- **CI-M-002-006** `src/features/orders/order-detail/__tests__/action.test.ts::describe(retryPayment)`: New test file (or extends existing action.test.ts if one exists). Vitest suite for retryPayment server action. Uses vi.mock("@/lib/prisma") and vi.mock("@/lib/auth") mirroring the established mock-based action-test pattern (no real DB). Four tests cover the four canonical branches: (1) auth guard — auth() returns null -> action returns { message: "Unauthorized." } without touching prisma; (2) ownership re-check — auth() returns session for clientB; tx.order.findUnique resolves to order owned by clientA -> action returns { message: "Order not found." } and order.update is never called; (3) invalid status edge — order found with status QUOTE_PROVIDED (not PAYMENT_FAILED) -> action returns { message: "Order cannot be retried from current status." } and order.update is never called; (4) happy path — order found in PAYMENT_FAILED with matching clientId -> tx.order.update called with status: PAYMENT_PENDING and redirect is invoked with /dashboard/orders/${orderId}/pay (assert via the established next/navigation redirect mock). Mock setup mirrors the acceptQuote test pattern if one exists; otherwise establish the pattern fresh and document it in the slice CLAUDE.md as the canonical mock-based action-test for this slice. (refs: DL-002, DL-003, DL-004)

#### Code Changes

**CC-M-002-001** (src/features/orders/order-detail/action.ts) - implements CI-M-002-001

**Code:**

```diff
--- a/src/features/orders/order-detail/action.ts
+++ b/src/features/orders/order-detail/action.ts
@@ -43,6 +43,6 @@ export async function acceptQuote(
   if (result !== null) return result

-  redirect(`/checkout/${orderId}`)
+  redirect(`/dashboard/orders/${orderId}/pay`)
 }
@@ -83,3 +83,36 @@ export async function rejectQuote(
   revalidatePath(`/dashboard/orders/${orderId}`)
   return null
 }
+
+export async function retryPayment(
+  _prevState: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const orderId = formData.get('orderId') as string | null
+  if (!orderId) return { message: 'Missing order ID.' }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const result = await prisma.$transaction(async (tx) => {
+    const order = await tx.order.findUnique({
+      where: { id: orderId },
+    })
+
+    if (!order || order.clientId !== session.user.id) {
+      return { message: 'Order not found.' }
+    }
+    if (!isValidStatusTransition(order.status, OrderStatus.PAYMENT_PENDING)) {
+      return { message: 'Order cannot be retried from current status.' }
+    }
+
+    await tx.order.update({
+      where: { id: orderId },
+      data: { status: OrderStatus.PAYMENT_PENDING },
+    })
+
+    return null
+  })
+
+  if (result !== null) return result
+
+  redirect(`/dashboard/orders/${orderId}/pay`)
+}
```

**Documentation:**

```diff
--- a/src/features/orders/order-detail/action.ts
+++ b/src/features/orders/order-detail/action.ts
@@ -83,3 +83,6 @@ export async function rejectQuote(
   revalidatePath(`/dashboard/orders/${orderId}`)
   return null
 }
+
+// retryPayment: PAYMENT_FAILED→PAYMENT_PENDING transition only; no Xendit invoice created.
+// Redirect goes to canonical checkout route /dashboard/orders/[orderId]/pay. (ref: DL-003, DL-004)
```


**CC-M-002-002** (src/features/orders/order-detail/ui.tsx) - implements CI-M-002-002

**Code:**

```diff
--- a/src/features/orders/order-detail/ui.tsx
+++ b/src/features/orders/order-detail/ui.tsx
@@ -4,7 +4,8 @@ import { Card, CardContent } from '@/components/ui/card'
 import { Button } from '@/components/ui/button'
-import { acceptQuote, rejectQuote } from './action'
+import { acceptQuote, rejectQuote, retryPayment } from './action'
@@ -44,3 +44,27 @@ export function OrderDetailQuoteActions({
   )
 }
+
+export function OrderDetailRetryPayment({
+  orderId,
+}: {
+  orderId: string
+}) {
+  const [state, retryAction] = useActionState(retryPayment, null)
+
+  return (
+    <Card className="mt-4">
+      <CardContent className="pt-6">
+        <p className="text-sm text-gray-700 mb-4">
+          Your previous payment attempt expired. Click Retry Payment to start a new payment.
+        </p>
+        <form action={retryAction}>
+          <input type="hidden" name="orderId" value={orderId} />
+          <Button type="submit">Retry Payment</Button>
+        </form>
+        {state?.message && (
+          <p className="mt-2 text-sm text-red-600">{state.message}</p>
+        )}
+      </CardContent>
+    </Card>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/orders/order-detail/ui.tsx
+++ b/src/features/orders/order-detail/ui.tsx
@@ -44,3 +44,6 @@ export function OrderDetailQuoteActions({
   )
 }
+
+// OrderDetailRetryPayment: single-action card rendered only when status === PAYMENT_FAILED.
+// Does not re-display quotedPrice — user already accepted quote before reaching this state.
```


**CC-M-002-003** (src/features/orders/order-detail/page.tsx) - implements CI-M-002-003

**Code:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -5,7 +5,7 @@ import { auth } from '@/lib/auth'
 import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
-import { OrderDetailQuoteActions } from './ui'
+import { OrderDetailQuoteActions, OrderDetailRetryPayment } from './ui'
@@ -366,6 +366,10 @@ export default async function OrderDetailPage({
         {dto.status === 'QUOTE_PROVIDED' && dto.quotedPrice != null && (
           <OrderDetailQuoteActions orderId={dto.id} quotedPrice={dto.quotedPrice} />
         )}
+
+        {dto.status === 'PAYMENT_FAILED' && (
+          <OrderDetailRetryPayment orderId={dto.id} />
+        )}

         {dto.status === 'QUOTE_REJECTED' && (
```

**Documentation:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -5,5 +5,5 @@ import { auth } from '@/lib/auth'
 import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
-import { OrderDetailQuoteActions } from './ui'
+import { OrderDetailQuoteActions, OrderDetailRetryPayment } from './ui'
```


**CC-M-002-004** (src/app/dashboard/orders/[orderId]/pay/page.tsx) - implements CI-M-002-004

**Code:**

```diff
--- /dev/null
+++ b/src/app/dashboard/orders/[orderId]/pay/page.tsx
@@ -0,0 +1,4 @@
+// App router mount point for the checkout RSC.
+// Implementation lives in src/features/payments/checkout/page.tsx per VSA boundary rules (ADR-001).
+// This file is a re-export only; all logic belongs to the feature slice.
+export { default } from '@/features/payments/checkout/page'
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/app/dashboard/orders/[orderId]/pay/page.tsx
@@ -0,0 +1,4 @@
+// App router mount point for the checkout RSC.
+// Implementation lives in src/features/payments/checkout/page.tsx per VSA boundary rules (ADR-001).
+// This file is a re-export only; all logic belongs to the feature slice.
+export { default } from '@/features/payments/checkout/page'
```


**CC-M-002-005** (src/features/orders/order-detail/CLAUDE.md) - implements CI-M-002-005

**Code:**

```diff
--- a/src/features/orders/order-detail/CLAUDE.md
+++ b/src/features/orders/order-detail/CLAUDE.md
@@ -8,7 +8,8 @@
 | File        | What                                                                             | When to read                                                         |
 | ----------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
 | `page.tsx`  | Async RSC — CLIENT auth guard, ownership guard, Decimal/Date DTO, full render   | Modifying auth gate, order fetch, DTO fields, badge map, or timeline |
-| `ui.tsx`    | `'use client'` — `OrderDetailQuoteActions`: Accept/Reject forms with `useActionState`, rendered only when status === `QUOTE_PROVIDED` | Modifying quote action panel layout or error display |
-| `action.ts` | `acceptQuote` (QUOTE_PROVIDED→PAYMENT_PENDING direct transition, redirect to checkout), `rejectQuote` (→QUOTE_REJECTED, revalidatePath) | Modifying accept/reject transitions |
+| `ui.tsx`    | `'use client'` — `OrderDetailQuoteActions` (Accept/Reject, QUOTE_PROVIDED), `OrderDetailRetryPayment` (Retry Payment, PAYMENT_FAILED) | Modifying action panel layout or error display |
+| `action.ts` | `acceptQuote` (QUOTE_PROVIDED→PAYMENT_PENDING, redirect to checkout), `rejectQuote` (→QUOTE_REJECTED), `retryPayment` (PAYMENT_FAILED→PAYMENT_PENDING, redirect to checkout) | Modifying accept/reject/retry transitions |
@@ -20,6 +20,11 @@ Guard: Renders 404 for any order that does not belong to the authenticated clien
 - `rejectQuote` is terminal for T-07. The `QUOTE_REJECTED→QUOTE_REQUESTED` re-request loop is T-09.
 - Client quote actions are inline (not a separate slice) because `QUOTE_PROVIDED` renders the same order summary as all other statuses plus an action panel — a dispatcher would require duplicating the base rendering or an ADR-001-violating cross-slice import.
 - `OrderDetailQuoteActions` is only rendered when `dto.status === 'QUOTE_PROVIDED' && dto.quotedPrice != null`. Both checks are intentional: the status check is the logic gate; the null check is deploy-safety.
+- `retryPayment` does not create a Xendit invoice — it only transitions PAYMENT_FAILED→PAYMENT_PENDING and redirects to the checkout page; `initiateCheckout` creates the fresh invoice when the client clicks Pay.
+- `retryPayment` redirect target is `/dashboard/orders/${orderId}/pay` — the canonical checkout route mounted at `src/app/dashboard/orders/[orderId]/pay/page.tsx`.
+- `acceptQuote` redirect target is `/dashboard/orders/${orderId}/pay` (same canonical checkout route). The historical `/checkout/${orderId}` target had no app router mount.
+- `OrderDetailRetryPayment` is only rendered when `dto.status === 'PAYMENT_FAILED'`.
```

**Documentation:**

```diff
--- a/src/features/orders/order-detail/CLAUDE.md
+++ b/src/features/orders/order-detail/CLAUDE.md
@@ -8,7 +8,8 @@
 | File        | What                                                                             | When to read                                                         |
 | ----------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
 | `page.tsx`  | Async RSC — CLIENT auth guard, ownership guard, Decimal/Date DTO, full render   | Modifying auth gate, order fetch, DTO fields, badge map, or timeline |
-| `ui.tsx`    | `'use client'` — `OrderDetailQuoteActions`: Accept/Reject forms with `useActionState` | Modifying quote action panel layout or error display |
+| `ui.tsx`    | `'use client'` — `OrderDetailQuoteActions` (QUOTE_PROVIDED), `OrderDetailRetryPayment` (PAYMENT_FAILED) | Modifying action panel layout or error display |
+| `action.ts` | `acceptQuote`, `rejectQuote`, `retryPayment` — client order status transitions   | Modifying accept/reject/retry transitions |
```


**CC-M-002-006** (src/features/orders/order-detail/__tests__/action.test.ts) - implements CI-M-002-006

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/order-detail/__tests__/action.test.ts
@@ -0,0 +1,101 @@
+import { describe, it, expect, vi, beforeEach } from 'vitest'
+import { OrderStatus } from '@prisma/client'
+
+const mockOrderFindUnique = vi.fn()
+const mockOrderUpdate = vi.fn()
+const mockTx = {
+  order: {
+    findUnique: mockOrderFindUnique,
+    update: mockOrderUpdate,
+  },
+}
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    $transaction: vi.fn((cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
+  },
+}))
+
+const mockRedirect = vi.fn()
+vi.mock('next/navigation', () => ({
+  redirect: mockRedirect,
+}))
+
+vi.mock('next/cache', () => ({
+  revalidatePath: vi.fn(),
+}))
+
+vi.mock('@/lib/auth', () => ({
+  auth: vi.fn(),
+}))
+
+vi.mock('@/domain/orders/state-machine', () => ({
+  isValidStatusTransition: vi.fn(),
+}))
+
+import { retryPayment } from '../action'
+import { auth } from '@/lib/auth'
+import { isValidStatusTransition } from '@/domain/orders/state-machine'
+
+const mockAuth = vi.mocked(auth)
+const mockIsValidStatusTransition = vi.mocked(isValidStatusTransition)
+
+const CLIENT_SESSION = {
+  user: { id: 'client-user-id', role: 'CLIENT' },
+  expires: '2099-01-01',
+}
+
+const ORDER_ID = 'test-order-id'
+
+function makeFormData(orderId: string) {
+  const fd = new FormData()
+  fd.append('orderId', orderId)
+  return fd
+}
+
+describe('retryPayment', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mockRedirect.mockImplementation(() => { throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT' }) })
+  })
+
+  it('returns Unauthorized when session is absent', async () => {
+    mockAuth.mockResolvedValue(null)
+
+    const result = await retryPayment(null, makeFormData(ORDER_ID))
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mockOrderFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns Order not found when order.clientId does not match session', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mockOrderFindUnique.mockResolvedValue({
+      id: ORDER_ID,
+      clientId: 'other-client-id',
+      status: OrderStatus.PAYMENT_FAILED,
+    })
+
+    const result = await retryPayment(null, makeFormData(ORDER_ID))
+
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mockOrderUpdate).not.toHaveBeenCalled()
+  })
+
+  it('returns error message when status transition is invalid', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mockOrderFindUnique.mockResolvedValue({
+      id: ORDER_ID,
+      clientId: 'client-user-id',
+      status: OrderStatus.QUOTE_PROVIDED,
+    })
+    mockIsValidStatusTransition.mockReturnValue(false)
+
+    const result = await retryPayment(null, makeFormData(ORDER_ID))
+
+    expect(result).toEqual({ message: 'Order cannot be retried from current status.' })
+    expect(mockOrderUpdate).not.toHaveBeenCalled()
+  })
+
+  it('updates order to PAYMENT_PENDING and redirects to checkout on success', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mockOrderFindUnique.mockResolvedValue({
+      id: ORDER_ID,
+      clientId: 'client-user-id',
+      status: OrderStatus.PAYMENT_FAILED,
+    })
+    mockIsValidStatusTransition.mockReturnValue(true)
+    mockOrderUpdate.mockResolvedValue({})
+
+    await expect(retryPayment(null, makeFormData(ORDER_ID))).rejects.toThrow('NEXT_REDIRECT')
+    expect(mockOrderUpdate).toHaveBeenCalledWith({
+      where: { id: ORDER_ID },
+      data: { status: OrderStatus.PAYMENT_PENDING },
+    })
+    expect(mockRedirect).toHaveBeenCalledWith(`/dashboard/orders/${ORDER_ID}/pay`)
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/order-detail/__tests__/action.test.ts
@@ -0,0 +1,5 @@
+// Unit tests for retryPayment server action.
+// Uses full Prisma mock (vi.fn()) and next/navigation redirect mock.
+// Four branches: auth guard, ownership re-check, invalid status, happy path.
+// redirect() throws NEXT_REDIRECT in Next.js — happy path asserts rejects.toThrow.
```


## Execution Waves

- W-001: M-001
- W-002: M-002
