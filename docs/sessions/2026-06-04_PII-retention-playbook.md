# PII Retention & Deletion (RA 10173) — playbook

Plan document: `plans/T22-pii-retention-deletion.md` (to be written by the planner) — **proposed
ticket id T-22; assign the next free T-id when you add it to the roadmap.**
Branch: `feat/T22-pii-retention-deletion`
Estimated sessions: 2–3 | Estimated wall time: ~3–5 hours
Why this is next: the roadmap (T-12, PR #19) flags it as **required before the first commercial
transaction** — uploaded SPECIFICATION/RESULT documents and `ClientProfile` rows hold personal
data (names, contact details, test results) with **no defined retention period or deletion path**.
RA 10173 (Data Privacy Act of the Philippines) requires storage limitation + secure disposal +
data-subject erasure. T-20 captured *consent*; this ticket closes the *disposal* half.

> **This ticket is HALF POLICY, HALF ENGINEERING.** The retention **schedule** (how long each data
> category is kept, and the lawful basis) is a legal/business input the planner **cannot invent** —
> resolve Decision 2 with the owner before planning, or the plan will hard-code guesses. The
> engineering arm (deletion mechanics, expiry trigger, erasure-request surface, audit log) is
> normal `[planner]` work once the schedule exists.

> **This ticket likely OWES a schema migration + `npx prisma db push` per environment** (a deletion
> audit-log model and/or `deletedAt`/`anonymizedAt` columns). Treat it like T-19: not "no migration."

---

## The full cycle (planning → /clear → implement)

`[planner]` ticket. Run the three phases in order; do not collapse them.

### Phase A — Explore + Plan (session 1)
1. Resolve every Pre-session decision below FIRST — especially **Decision 2 (retention schedule)**,
   which needs the business/legal owner, not the planner.
2. Hand the planner the **anchor files** below up front (verified to exist 2026-06-04):

   | File | Why it anchors the plan |
   | ---- | ----------------------- |
   | `prisma/schema.prisma` | the PII-bearing models — `ClientProfile`, `Attachment`, `LabDocument`, `OrderDispute`, `User`, `Transaction`, `Order`. Note existing `ClientProfile … onDelete: Cascade` from `Order`. |
   | `src/lib/storage/r2.ts` | currently exposes **only** `PutObjectCommand` + `GetObjectCommand` presign. A `DeleteObjectCommand` helper must be added here — object deletion is the storage half of "delete a document". |
   | `src/lib/storage/constants.ts` | MIME/size limits; same namespace the delete helper belongs to. |
   | `src/features/orders/spec-upload/` + `result-upload/` | how Attachments are created + `viewOrderAttachment` / `viewResultAttachment` read them; deletion must mirror the same `r2Key` authority + ownership posture. |
   | `src/features/labs/kyc-upload/` | `LabDocument` create/read; KYC docs are the most sensitive category. |
   | `src/domain/orders/client-details.ts` | `clientDetailsSchema` + `SENSITIVE_SERVICE_CATEGORIES` — the RA 10173 sensitivity classification already in the domain layer; retention rules may key off it. |
   | `src/app/privacy/` (T-20 privacy notice) | the public privacy notice — the retention schedule + erasure process must be reflected here, not only in code. |
   | `src/features/admin/order-oversight/` + `kyc-review/` | admin list+detail + two-layer-auth pattern to mirror if erasure is admin-driven (Decision 6). |
   | `src/features/payments/payouts/handlers.ts` + `webhooks/handlers.ts` | canonical `updateMany` CAS + `$transaction` discipline for the deletion/anonymization writes. |

3. Invoke the **planner skill in planning mode**: `python3 -m skills.planner.orchestrator.planner --step 1`.
4. Let it interview + write `plans/T22-pii-retention-deletion.md` (milestones, per-milestone Code
   Intent + Code Changes, test plan — same shape as `plans/T-19-dispute-redress.md`).
5. Do not declare "ready to implement" until the planner has (a) steelmanned each decision and
   (b) run a quality-reviewer pass over the plan steps.

### Phase B — `/clear`
Plan state on disk (`.claude/planner-state/`) is the handoff, not the conversation.

### Phase C — Implement (session 2–3)
Worktree first: `git worktree add wt/T22-pii-retention-deletion -b feat/T22-pii-retention-deletion main`.
Test with `./scripts/test-local.sh` (offline local Postgres; from PR #22).

---

## PII inventory (what actually holds personal data)

| Store | Personal data | Notes / tension |
| ----- | ------------- | --------------- |
| `ClientProfile` (DB) | name, email, phone, organization, address | per-order snapshot; `onDelete: Cascade` from `Order`; has `consentGiven/At` (T-20) |
| `Attachment` (DB + **R2 object**) | `fileName`; the **object** = SPECIFICATION (client) / RESULT (lab) — test results, often sensitive | two stores to delete: DB row **and** the R2 object (`r2Key`) |
| `LabDocument` (DB + **R2 object**) | KYC docs (IDs, business registration) — most sensitive | same two-store deletion |
| `OrderDispute` (DB) | `reason`, `resolutionNote` (free text — may contain PII) | ITA redress audit trail — retention tension (Decision 3) |
| `User` (DB) | email (auth identity) | deleting breaks auth/account linking — anonymize, don't hard-delete |
| `Order` / `Transaction` (DB) | `notes`, payment refs, `vaNumber`, amounts | **BIR financial-record retention (NIRC ~10 yr) likely forbids early deletion** — see Decision 2 |

---

## Pre-session — resolve these BEFORE calling the planner

### Decision 1 (scope boundary): which categories, and how far does "deletion" go?
Options, smallest → largest: (a) **uploaded documents only** (`Attachment` + `LabDocument` DB rows +
R2 objects) — directly closes the T-12 flag; (b) + `ClientProfile`/`OrderDispute` text;
(c) full **data-subject erasure** (DSAR) across every store including `User` anonymization.
Recommendation: **scope this ticket to (a)+(b) — documents + profile/dispute text — with a documented
retention schedule; defer full self-serve DSAR** to a follow-on. Pin the boundary so the planner
does not balloon into an account-deletion feature.

### Decision 2 (THE policy input): the retention schedule per category — needs the owner, not the planner
Define, per category above, **retention period + lawful basis + disposal action**. This is a legal/
business decision. Unblock before planning. Known tensions to resolve:
- **BIR / NIRC:** financial records (Transactions, receipts, and arguably the Order they tie to)
  generally must be kept **~10 years**. PII *documents* can go sooner; the *financial ledger* cannot.
- **ITA 2023 redress:** the `OrderDispute` audit trail must stay auditable for a defined period.
- **Lab test-result retention:** RESULT documents may carry a sector-mandated retention (DOH / ISO
  17025 / client contract) **longer** than the client would want — clarify before allowing deletion.
- **NPC expectation:** a written retention schedule must exist and be reflected in the privacy notice.
Output of this decision = a table the plan and the `/privacy` page both cite.

### Decision 3: delete vs anonymize vs tombstone, per category
Hard-delete (row + R2 object) for documents past retention; **anonymize** (null the PII columns, keep
the row) where an FK/audit/financial reference must survive (`ClientProfile` tied to a retained
`Order`; `OrderDispute.reason`; `User.email`). Decide the exact treatment per category — a blanket
cascade delete will violate BIR retention and break referential integrity.

### Decision 4 (storage mechanics): R2 object deletion + DB write ordering
`r2.ts` has no delete today. Add `deleteObject(r2Key)` (`DeleteObjectCommand`, `AbortSignal.timeout`
per the external-call discipline). Decide ordering: delete the **DB row/anonymize first inside a
`$transaction`, then best-effort delete the R2 object**, with orphaned-object tolerance (object delete
failing must not roll back the DB intent; reconcile via a sweep). Never leave a readable object whose
DB row is gone-or-anonymized. Mirror the `r2Key`-is-authoritative invariant from T-12.

### Decision 5 (trigger model): what initiates a deletion? (no cron infra exists yet)
Three triggers, decide which are in scope: (i) **retention expiry** (time-based — but the repo has
**no scheduler**; options: a manual/admin "run retention sweep" action, a GitHub Action cron — note
**Actions is currently billing-locked** — or defer the automated sweep and ship the deletion
*primitive* + a manual trigger); (ii) **data-subject erasure request** (event-driven); (iii) **admin
manual**. Recommendation: ship the **deletion primitive + an admin-triggered sweep** now; defer the
automated scheduler until the cron/billing story is settled. Do not block the primitive on infra.

### Decision 6: erasure-request surface — self-serve client vs admin-driven
Self-serve client erasure is a bigger surface (identity, auth, legal-hold checks). Recommendation:
**admin-driven erasure** for this ticket (mirror `kyc-review` two-layer-auth list+detail), with a
documented manual intake; defer a self-serve client button. Keep scope honest.

### Decision 7 (accountability): deletion audit log
RA 10173 accountability ⇒ record **what was deleted/anonymized, when, by whom, under which retention
rule** — likely a new `DataDeletionLog` model (schema migration + `db push`). Decide fields now so the
migration is one pass. Do **not** store the deleted PII in the log (defeats the purpose) — store the
category, the subject/order id, the action, the actor, the basis, the timestamp.

### Decision 8: legal-hold / exclusions — never delete these
A deletion/expiry MUST skip records under: an **open dispute** (`Order.status === DISPUTED`), a
**pending/failed payment**, an **in-window BIR retention**, or an active accreditation review. Define
the predicate now; it is the safety gate of the whole feature.

---

## Watch-points during implementation
- **Two-store deletion is not atomic.** DB `$transaction` first (delete/anonymize), then best-effort R2
  delete; tolerate object-delete failure without rolling back, and log it for a reconciling sweep.
- **`r2Key` stays authoritative** — never trust `fileUrl`; mint nothing public. Deletion keys off `r2Key`.
- **Anonymize, never null a schema-non-null PII column without a migration** — `ClientProfile.name/
  email/phone` are non-null; anonymizing means writing a sentinel or making them nullable (migration).
- **Legal-hold predicate runs before every delete** (Decision 8) — a held record silently skipped is a
  bug; surface skips in the sweep result.
- **`/privacy` notice must match the code** — the shipped retention schedule and erasure process have to
  appear in the public notice (incoherence between them is itself an RA 10173 problem).
- **Deletion is irreversible** — gate behind admin auth (layer-2 re-check) + an explicit confirm; log first.

## Tests (offline, `./scripts/test-local.sh`)
- retention/legal-hold predicate: an `Order.status===DISPUTED` / pending-payment / in-window record is
  **skipped**; an eligible record is selected.
- deletion primitive: DB row deleted/anonymized **and** `deleteObject(r2Key)` called with the right key;
  R2 failure does not roll back the DB write (orphan tolerated + logged).
- anonymization: PII columns nulled/sentinelled; FK/audit row survives; financial ledger untouched.
- `DataDeletionLog` row written with category/subject/actor/basis/timestamp and **no PII**.
- admin auth: non-admin cannot trigger a sweep/erasure (layer-2 re-check).

## DevOps Pre-Flight (run before any "verify / deploy" step)
- `npx prisma db push` per env if a `DataDeletionLog` model and/or nullable-PII columns are added
  (DL-009 — unpushed = runtime crash, not a type error).
- R2 credentials present for the env (delete needs write/delete perms on the bucket — confirm the R2
  token scope, not just read/put).
- Offline tests mock the `@aws-sdk/client-s3` boundary — no live R2 needed for the unit suite.

## Open questions to route to legal / NPC (block Decision 2)
1. Retention period per category (documents, profile, dispute text, financial ledger).
2. Does RESULT-document retention have a sector mandate (DOH / ISO 17025 / client contract)?
3. BIR financial-record retention window for this entity (confirm ~10 yr applies).
4. Is a self-serve erasure right required at launch, or is admin-driven intake acceptable initially?

## Protocol reminders
- PR per ticket; CodeRabbit auto-reviews; squash-merge + delete branch; `[planner]` full cycle.
- Run the **DevOps Readiness Protocol** if a provisioning/env gap blocks the session.
- After this + the refund ticket merge, the Compounding Protocol trigger (3–5 PRs since #20) will be due.
