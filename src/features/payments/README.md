# payments/

Cross-cutting payment IK — deduplication architecture shared across the `webhooks/` and `payouts/` slices.

## Dedup Architecture

Webhook dedup across all payment handlers uses layered guards, each closing a different concurrency window:

**Layer 1 — IdempotencyKey table (broadest, pre-lookup):** Checked as the first step inside every handler's `$transaction`. Key format: `provider:product:event:externalId` (e.g. `xendit:invoice:PAID:{id}`, `xendit:invoice:EXPIRED:{id}`, `xendit:settlement:COMPLETED:{id}`). A duplicate delivery that finds an existing key returns 200 before any entity lookup. Key is created as the last step — not first — so a transient mid-handler error rolls back both the key and the business writes, leaving Xendit retries free to re-attempt the work.

**Layer 2 — Entity-state guards (post-lookup):** Transaction.status and Payout.status checks that enforce state-machine invariants independent of dedup. These encode terminal-state semantics (CAPTURED is terminal for PAID; FAILED is terminal for EXPIRED) and contract-violation throws (PROCESSING/FAILED Payout statuses are unexpected). Removing these guards would lose the state-machine invariants even if Layer 1 is present.

**Layer 3 — Concurrent first-delivery CAS (settlement only):** `Payout.updateMany` with `{ id, externalPayoutId: null }` predicate + `count === 0` short-circuit. Closes the race between two simultaneous first deliveries that both pass Layers 1 and 2 before the first one writes `externalPayoutId`.

All three layers are required simultaneously. Each closes a different race window; removing any one layer leaves a slice of unprotected concurrent behavior.
