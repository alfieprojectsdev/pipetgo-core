# T-12 Planning Session — Complete

**Date:** 2026-06-02
**Branch to create:** `feat/T12-attachment-uploads`
**Plan file:** `plans/T-12-attachment-uploads.md` (5306 lines, QR-verified)
**State dir (ephemeral):** `/tmp/claude-1000/planner-jcty5z5r` — discardable; plan is persisted
**Playbook:** `docs/sessions/2026-06-01_T-12-playbook.md`

---

## What happened this session

Explore (playbook Session 1, Step 2) read the storage layer (`src/lib/storage/r2.ts`,
`constants.ts`), the two-step upload pattern (`labs/accreditation-upload/`,
`labs/kyc-upload/`), the on-demand presigned-GET viewer
(`admin/accreditation-review/view-document-action.ts`), both extension surfaces
(`orders/order-detail/` CLIENT, `orders/lab-fulfillment/` LAB_ADMIN), and the `Attachment`
model. Findings fed `context.json`. Then the full planner orchestrator cycle ran
(plan-design → plan-code → plan-docs, each gated by QR).

Three front-loaded decisions resolved before plan-design (architect raised them, user chose):

- **Row timing → pre-presign.** Create the `Attachment` row before presigning, carrying the
  server-generated `r2Key`; confirm is an idempotent no-op acknowledgment (no status column to
  advance); orphan rows on abandoned uploads tolerated (same as kyc-upload). Add
  `Attachment.r2Key String @unique`; keep `fileUrl String?` (nullable).
- **RESULT MIME → PDF-only.** RESULT uses a per-type `RESULT_ALLOWED_MIME_TYPES =
  ['application/pdf']` allowlist; SPECIFICATION keeps the shared pdf/jpeg/png allowlist.
- **Status window → strict-result.** SPECIFICATION allowed while pre-fulfilment (not
  COMPLETED/CANCELLED); RESULT allowed only while order is IN_PROGRESS — prevents silent
  post-completion result swaps under ITA result-integrity liability. Both server-enforced.

## QR catches (the value of the gate)

- **plan-design QR** (1 fix iteration): `fileUrl` had to stay nullable for the pre-presign
  create to succeed; the SPECIFICATION status window was reframed as a positive fail-closed
  allowlist (excludes REFUND_PENDING/REFUNDED/QUOTE_REJECTED); the cross-actor
  RESULT-read-by-CLIENT predicate was made attachmentType-agnostic with an explicit
  `order.clientId` check; a residual decision fork marker was resolved.
- **plan-code QR** (3 fix iterations): null relation after `include` → throw; RESULT upload
  gated on `order.status === 'IN_PROGRESS'`; idempotency `findUnique` before create;
  `validateSize`/prefix parameterized via an explicit `'labs/' | 'orders/'` allowlist (never a
  wildcard — the defense-in-depth invariant); 16 diff hunk line-count mismatches corrected.
- **plan-docs QR** (1 fix iteration): temporal-contamination comments removed (`T-18 lost two
  test files…`, `introduced to support…`), a stale `resultAttachments always []` comment that
  contradicted the CLIENT-read decision rewritten, two WHAT-only HTML comments dropped.

**Plan shape:** 10 decisions (DL-001..011), 6 rejected alternatives, 8 constraints, 4 risks,
1 architecture diagram, 5 milestones (3 waves), 53 code + doc changes.

## Resilience notes

- **Session-limit reset hit once** mid plan-code QR-verify (all three verify agents returned the
  account-level limit with 0 tokens, no result). The fixes were already persisted in `plan.json`
  (developer fix-mode had completed PASS); on reset, only the re-verification was re-dispatched —
  zero rework. State dir survived in `/tmp` across the reset.
- **One accidental user interrupt** on the docs-QR verify wave; re-dispatched the same three
  agents fresh — clean.

## Execution watch-point (carry into the implement session)

The client-RESULT-download path. The docs phase reconciled the `order-detail/page.tsx` comment
to state the CLIENT is authorized to download both SPECIFICATION and RESULT attachments
(per DL-011, the type-agnostic CLIENT read), but M-005's `order-detail` query as written fetches
only SPECIFICATION attachments. The implementing agent must ALSO fetch RESULT attachments on
order-detail so the client has an attachment id to click — otherwise the CLIENT viewer action is
unreachable for results. Verify during execution.

## Next

Execute the plan: `git checkout -b feat/T12-attachment-uploads`, then
`Use your planner skill to execute plans/T-12-attachment-uploads.md in a worktree in wt/`.
Schema first (`npx prisma db push` — dev DB is push-managed; DATABASE_URL must be set, which
blocked the T-18 session). After merge: run the Compounding Protocol — T-18 (PR #18) + T-12 is
the next 3–5-PR batch since PR #17.
