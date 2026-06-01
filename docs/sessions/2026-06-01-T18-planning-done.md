# T-18 Planning Session — Complete

**Date:** 2026-06-01
**Branch to create:** `feat/T18-lab-verification`
**Plan file:** `plans/T-18-lab-verification.md` (2260 lines, QR-verified)
**State dir (ephemeral):** `/tmp/claude-1000/planner-yqc_gs1o` — not needed for implementation
**Playbook:** `docs/sessions/2026-05-31_T-18-playbook.md`

---

## What happened this session

Explore (Session 1, Step 2 of the playbook) read the full T-13 admin slice, the kyc-upload
two-step pattern, both gate points, and the schema; findings fed `context.json`. Then the full
planner orchestrator cycle ran (plan-design → plan-code → plan-docs, each gated by QR):

- **plan-design QR:** PASS (1 fix iteration — risks lacked per-milestone owners; DL-012 test
  traceability orphan; kyc-review cascade follow-up unowned; M-004 falsely claimed coverage by
  the create-order test)
- **plan-code QR:** PASS (1 fix iteration — **the important catch:** the reject path originally
  did a bare `tx.lab.updateMany({where:{id}})` that could clobber a *prior verification* on
  replay/concurrency → now CAS-guarded `{id, isVerified:false}` + `count===0`; the cloned
  `confirm-action` had dropped the `count===0` early-return → restored; the DL-012 create-order
  gate test the plan mandates was missing → added; dead ternary in the queue UI; decision-ref
  labels)
- **plan-docs QR:** PASS (2 fix iterations — temporal contamination: a `per PR #17 / Compounding
  Protocol` source comment, a `T-18 updates below` HTML signpost, and a roadmap `migrate dev` vs
  `db push` contradiction; second sweep cleared remaining change-narrative phrasing across all
  doc_diffs)

12 decisions (DL-001…DL-012), 18 code changes (+ a create-order gate test) across 6 milestones,
3 waves, all with doc overlays. The plan file is the authoritative implementation spec.

**Resilience note:** session-limit reset hit twice (QR plan-code-decompose, developer plan-code
fix) plus one accidental user interrupt during the architect rollout-question relay. All resumed
cleanly by re-dispatching the same agent against the persisted state dir — zero rework.

---

## Scope

T-18 = **ISO 17025 accreditation verification** — enforce the `Lab.isVerified` marketplace/ITA
gate. Explicitly independent of, and must not touch, `kycStatus` (T-13/T-15, shipped). Sibling
follow-ups: T-13b (admin order oversight, read-only), T-13c (admin role management, deferred).

**Rollout decision (DL-010, user-confirmed):** bootstrap the first verified lab by self-reviewing
one cert through the new admin UI (preferred — exercises the real CAS+cascade and leaves an audit
trail), with a manual `UPDATE labs SET "isVerified"=true WHERE id='<lab-id>';` per-environment
fallback. Both go in the roadmap DevOps checklist so an empty `/services` is not read as a bug.

---

## Key decisions captured in the plan

| DL | Decision |
|----|----------|
| DL-001 | Clone (not parameterise): new sibling slices `admin/accreditation-review/` + `labs/accreditation-upload/`; isolates the live KYC payment-gate path; badge maps/DTOs copied (ADR-001 VSA) |
| DL-002 | Cert lives in `LabDocument` (`documentType=ACCREDITATION_CERTIFICATE`), NOT order-scoped `Attachment` (`orderId` NOT NULL); the `AttachmentType.ACCREDITATION_CERTIFICATE` enum stays dead |
| DL-003 | Queue filters `isVerified=false` labs owning an `{ACCREDITATION_CERTIFICATE, UPLOADED}` `LabDocument`, `createdAt asc`; no new `accreditationStatus` enum |
| DL-004 | Verify is a **boolean CAS**: `updateMany({where:{id, isVerified:false}})` + `count===0` early-return; never a bare `update` |
| DL-005 | Doc cascade **scoped** to `documentType=ACCREDITATION_CERTIFICATE AND status:UPLOADED` — NOT kyc-review's unscoped `{labId, status:UPLOADED}` (cross-domain clobber risk) |
| DL-006 | Two server-side gates: `services/browse` `where lab.isVerified:true` (read) + `create-order/action.ts` reject when `!lab.isVerified` before the `$transaction` (security-critical ITA control) |
| DL-007 | Every admin accreditation action re-checks `role===ADMIN`; lab actions re-check `Lab.ownerId` (TOCTOU — layout guard does not protect POST-invocable actions) |
| DL-008 | FormData inputs `typeof`-narrowed, never `as string`; clone boundary handling from `admin/kyc-review/action.ts`, NOT `kyc-upload` (predates the rule) |
| DL-009 | Add `accreditationReviewedById/At/RejectionReason` + `LabAccreditationReviewer` relation (+ User inverse); apply via `prisma db push`, never `migrate dev`; migration files not committed |
| DL-010 | Rollout bootstrap of first verified lab — admin self-review (preferred) / manual `UPDATE` (fallback); both in roadmap DevOps checklist |
| DL-011 | Surface `isVerified` + `accreditationRejectionReason` back to the lab on the upload page; cert view via 300s presigned GET from server-trusted `r2Key` (IDOR guard) |
| DL-012 | Unit-only (vitest, full Prisma mocks, names aligned to handler calls); create-order gate gets a dedicated unverified-lab-rejected test mirroring `checkout/kyc-gate.test.ts` |

---

## Milestones & waves

| Milestone | Wave | Deliverable |
|-----------|------|-------------|
| **M-001** | 1 (foundation) | `prisma/schema.prisma` — `accreditationReviewedById/At/RejectionReason` + `LabAccreditationReviewer` relation; `prisma db push` (no committed migration) |
| **M-002** | 2 | `src/features/labs/accreditation-upload/` — LAB_ADMIN presigned-PUT cert upload (does NOT touch `kycStatus`), status + rejection-reason surfacing, route re-export |
| **M-003** | 2 ∥ | `src/features/admin/accreditation-review/` — queue + detail (presigned GET view) + verify/reject **boolean CAS** with `documentType`-scoped cascade; badges, CLAUDE.md, README, route re-exports |
| **M-004** | 2 ∥ | `src/features/services/browse/page.tsx` — add `lab: { isVerified: true }` to `findMany` (+ dedicated browse test) |
| **M-005** | 2 ∥ | `src/features/orders/create-order/action.ts` — `include lab.isVerified`, server-side reject; `page.tsx` DTO; dedicated gate test (the ITA control) |
| **M-006** | 3 | `docs/roadmap.md` first-verified-lab bootstrap checklist + `kyc-review/README.md` unscoped-cascade follow-up note |

---

## Critical gotchas (verified against code during planning)

1. **Reuse `LabDocument`, not `Attachment`** — the cert is lab-scoped; `Attachment.orderId` is NOT NULL. The roadmap's `AttachmentType.ACCREDITATION_CERTIFICATE` predates T-15 and stays dead.
2. **`isVerified` ≠ `kycStatus`** — independent gates/lifecycles. T-18 touches only `isVerified`. Grep the cloned slices for `kyc`/`KycStatus` before PR (clone-drift risk).
3. **Cascade MUST be `documentType`-scoped** — kyc-review's unscoped cascade is safe only while a lab has no non-KYC docs. M-006 carries a tracked follow-up to retro-scope the shipped KYC cascade before any second doc type is reviewed through it.
4. **`create-order` server reject is the liability control** — UI hiding is not a control (client can POST a `serviceId`). Both gates ship together.
5. **Verify/reject is a boolean CAS** — `updateMany({where:{id, isVerified:false}})` + `count===0`; the reject path is CAS-guarded too (prevents clobbering a prior verification).
6. **`prisma db push`, never `migrate dev`** — dev Neon is push-managed; `migrate dev` would drift/reset. Migrations gitignored.
7. **`documentType` allowlist throws on unknown** — the cert upload path must add `ACCREDITATION_CERTIFICATE` to its allowlist.
8. **Don't copy `kyc-upload`'s `as string`** — clone boundary handling from `admin/kyc-review/action.ts` (typeof-narrowed).

---

## Implementation starting point

### Files to CREATE
| File | What |
|------|------|
| `src/features/labs/accreditation-upload/{upload-action,confirm-action,page,ui}.ts(x)` + `CLAUDE.md` + `README.md` + `__tests__/` | LAB_ADMIN cert upload (presigned PUT; PENDING→UPLOADED only; no `kycStatus`/`isVerified` write); surfaces status + rejection reason |
| `src/app/dashboard/lab/accreditation/page.tsx` | Thin re-export |
| `src/features/admin/accreditation-review/{page,detail-page,action,view-document-action,ui,detail-ui}.tsx` + `CLAUDE.md` + `README.md` + `__tests__/` | Queue + detail + verify/reject boolean CAS + `documentType`-scoped cascade + presigned GET view |
| `src/app/dashboard/admin/accreditation/{page,[labId]/page}.tsx` | Thin re-exports (reuse existing `admin/layout.tsx` guard) |
| `src/features/orders/create-order/__tests__/verified-gate.test.ts` | Dedicated unverified-lab-rejected test (DL-012) |

### Files to MODIFY
| File | Change |
|------|--------|
| `prisma/schema.prisma` | `Lab` accreditation audit cols + `LabAccreditationReviewer` relation + `User` inverse |
| `src/features/services/browse/page.tsx` | `findMany` where `lab: { isVerified: true }` |
| `src/features/orders/create-order/action.ts` | re-fetch `include lab.isVerified`; reject `!isVerified` before `$transaction` |
| `src/features/orders/create-order/page.tsx` | surface `labIsVerified` in DTO |
| `docs/roadmap.md` | first-verified-lab bootstrap checklist (DL-010) |
| `src/features/admin/kyc-review/README.md` | unscoped-cascade follow-up note (DL-005) |

---

## PR workflow

```bash
# 1. Branch from up-to-date main
git checkout main && git pull && git checkout -b feat/T18-lab-verification

# 2. Execute in a worktree (planner)
#    "Use your planner skill to execute plans/T-18-lab-verification.md in a worktree in wt/"

# 3. Apply schema (NOT migrate dev — dev DB is push-managed; migrations gitignored)
npx prisma db push && npx prisma generate

# 4. Verify before PR
npx tsc --noEmit                                            # clean
npx vitest --config vitest.unit.config.ts --run            # all pass

# 5. Open PR against main
#    title: "feat: T-18 — Lab accreditation verification (ISO 17025 marketplace gate)"
```

Self-review against Implementation Discipline before merge — key risks: action-level ADMIN
re-check (priv-esc), boolean CAS `updateMany`+`count===0` on **both** verify and reject,
`documentType`-scoped cascade, the create-order server-side reject (ITA control), presigned GET
from server-trusted `r2Key`, RSC Decimal/Date serialization, `redirect()` after try/catch.

---

## After merge

- Update `docs/roadmap.md`: mark T-18 done; flip the Executive Summary key-risk row
  "`Lab.isVerified` (ISO 17025) gate not yet enforced" → enforced. Remaining Phase 4: T-12
  (attachments), T-19 (dispute/redress), T-13b (order oversight), T-13c (role mgmt).
- Run the **Compounding Protocol** if this is the 3rd–5th PR since the last run (last: after PR #17).
- Run the **DevOps Readiness Protocol** if a provisioning gap bites during deploy (per-env `db push`,
  first-verified-lab bootstrap).
- The ITA solidary-liability exposure for accreditation closes: unverified labs are no longer
  listable or orderable.
