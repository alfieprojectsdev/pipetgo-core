# T-13 Planning Session — Complete

**Date:** 2026-05-30
**Branch to create:** `feat/T13-admin`
**Plan file:** `plans/T-13-admin-panel.md` (1771 lines, QR-verified)
**State dir (ephemeral):** `/tmp/claude-1000/planner-pbajxiq0` — not needed for implementation
**Playbook:** `docs/sessions/2026-05-29_T-13-playbook.md`

---

## What happened this session

Full planner orchestrator cycle completed (plan-design → plan-code → plan-docs, each gated by QR):

- **plan-design QR:** PASS (1 fix iteration — empty `rejected_alternatives`/`constraints`/`risks`/`assumptions` arrays in context; `session.user.id` non-empty invariant uncited)
- **plan-code QR:** PASS (2 fix iterations — `@db.Text` on FK column violated convention; duplicate superseded M-001 diffs risked double-apply; stale `docs/roadmap.md` diff context lines + table separator)
- **plan-docs QR:** PASS (1 fix iteration — temporal contamination ("Updated", "now exported", "(T-13)"); queue "submission order" claim unsupported by data model; DL-011/DL-013 unanchored)

13 decisions (DL-001…DL-013), 21 code changes across 4 milestones, all with doc overlays. Plan file is the authoritative implementation spec — read it before starting.

**Resilience note:** session-limit reset hit twice (developer plan-code, QR plan-docs-decompose) plus one user interrupt during plan-design QR verify. All resumed cleanly by re-dispatching the same agent against the persisted state dir — zero rework.

---

## Scope (DECIDED 2026-05-29)

First PR ships **KYC review/approve only** + admin auth infrastructure. Explicitly out:
- User role management (CLIENT↔LAB_ADMIN↔ADMIN) → **T-13b**
- Order / transaction oversight → **T-13b**
- `Lab.isVerified` (ISO 17025 marketplace gate) → **T-18**
- Xendit KYC API submission → deferred (manual admin review is the gate, T-15 DL-018)

---

## Key decisions captured in the plan

| DL | Decision |
|----|----------|
| DL-001 | Two-layer auth: route-group `layout.tsx` guard **+** per-action `role===ADMIN` re-check (TOCTOU — layout does not protect Server Actions) |
| DL-002 | `kycStatus` write is CAS: `tx.lab.updateMany({where:{id, kycStatus:'SUBMITTED'}})` + `count===0` idempotent early-return — never bare `update` |
| DL-003 | Only `SUBMITTED → APPROVED\|REJECTED` allowed; other source state returns validation error; unhandled target throws |
| DL-004 | Doc viewing mints a 300s presigned GET URL **on click** via a dedicated action, from server-trusted `LabDocument.r2Key` — never in RSC payload, never client-supplied key |
| DL-005 | Audit metadata = 3 nullable cols on `Lab` (`kycReviewedById` named relation, `kycReviewedAt`, `kycRejectionReason`); latest-review-only |
| DL-006 | Rejection requires non-empty reason (validated before tx); approve clears reason to null |
| DL-007 | `LabDocument` UPLOADED→VERIFIED\|REJECTED cascades in the **same `$transaction`**, scoped to `{labId, status:'UPLOADED'}` |
| DL-008 | First ADMIN bootstrapped via documented manual SQL `UPDATE`; no self-service minting |
| DL-009 | Admin RSC DTOs serialize `Decimal`→`.toFixed(2)`, `Date`→`.toISOString()`; badge maps `as const satisfies Record<EnumType,…>`, copied not imported (VSA) |
| DL-010 | `findUnique` on `@unique` (`Lab.id`, `Lab.ownerId`, `LabDocument.id`) — never `findFirst` |
| DL-011 | Audit migration applied per-env via `npx prisma migrate dev`; migration file **not committed** (`prisma/migrations` gitignored); `schema.prisma` is committed source of truth |
| DL-012 | Queue lists labs filtered by `kycStatus` (default `SUBMITTED`), ordered `createdAt asc` |
| DL-013 | Queue/detail UX split: list-only queue + per-lab detail page with per-doc View links |

---

## Milestones & waves

| Milestone | Wave | Deliverable |
|-----------|------|-------------|
| **M-001** | 1 (foundation) | `prisma/schema.prisma` audit cols (`kycReviewedById/At/RejectionReason`) + `src/lib/storage/r2.ts` `generatePresignedGetUrl` + `storage/README.md` + `r2.test.ts` update |
| **M-002** | 2 | `src/features/admin/kyc-review/` slice — `page.tsx` (queue), detail `page.tsx`, `action.ts` (`approveOrRejectKyc` CAS + cascade in one `$transaction`; `viewKycDocument` GET-url mint), two UIs, `CLAUDE.md` + `README.md`, two unit test suites |
| **M-003** | 2 ∥ | `src/features/labs/kyc-upload/{page,ui}.tsx` — surface `kycRejectionReason` back to the lab |
| **M-004** | 3 | `src/app/dashboard/admin/layout.tsx` ADMIN guard + two thin route re-exports + `docs/roadmap.md` bootstrap SQL & T-13b follow-up |

---

## Critical gotchas (verified against code during planning)

1. **No `middleware.ts`, no `/dashboard` layout** — gating is per-page/per-action (lab-fulfillment DL-001 precedent). Admin needs layout guard **and** action re-checks.
2. **`r2.ts` had no GET URL** — only `generatePresignedPutUrl`; `storage/README` listed GET as a deliberate deferral. M-001 adds `generatePresignedGetUrl`. Hard dependency of M-002 detail page.
3. **No ADMIN user exists** — `UserRole.ADMIN` in enum, referenced nowhere. Bootstrap out-of-band (DL-008).
4. **Two distinct lab gates** — `kycStatus` (T-15, payment, this ticket) vs `isVerified` (T-18, ISO 17025). Do not conflate.
5. **No `kycSubmittedAt` column** — queue orders by `Lab.createdAt` (lab-creation order, used as submission-time proxy). Docs reworded to not over-claim.
6. **Migrations gitignored** — apply locally, do not commit migration files.

---

## Implementation starting point

### Files to CREATE
| File | What |
|------|------|
| `src/features/admin/kyc-review/page.tsx` | Queue RSC — labs filtered `kycStatus=SUBMITTED`, `createdAt asc` |
| `src/features/admin/kyc-review/[labId]/page.tsx` (or detail page.tsx) | Lab detail RSC — KYC badge, doc list, per-doc View links |
| `src/features/admin/kyc-review/action.ts` | `approveOrRejectKyc` (CAS + cascade + audit, one `$transaction`); `viewKycDocument` (GET-url mint) |
| `src/features/admin/kyc-review/ui.tsx` (+ queue/detail UIs) | Client components — approve/reject form, View buttons; badge maps `satisfies Record` |
| `src/features/admin/kyc-review/CLAUDE.md` + `README.md` | Slice invariants, bootstrap section (DL-008), migration note (DL-011) |
| `src/app/dashboard/admin/layout.tsx` | Route-group ADMIN guard (`auth()` → `role!=='ADMIN'` → redirect) |
| `src/app/dashboard/admin/kyc-review/page.tsx` (+ detail route) | Thin re-exports |
| `src/features/admin/kyc-review/__tests__/*.test.ts` | action + viewKycDocument unit suites |

### Files to MODIFY
| File | Change |
|------|--------|
| `prisma/schema.prisma` | `Lab.kycReviewedById String?` (+ named `User` relation), `kycReviewedAt DateTime?`, `kycRejectionReason String?` |
| `src/lib/storage/r2.ts` | add `generatePresignedGetUrl(key)` — 300s TTL, `labs/` guard, `server-only` |
| `src/lib/storage/__tests__/r2.test.ts` | assert both presign fns exported |
| `src/lib/storage/README.md` | remove "deferred GET URL" deferral note |
| `src/features/labs/kyc-upload/page.tsx` + `ui.tsx` | surface `kycRejectionReason` |
| `docs/roadmap.md` | bootstrap SQL + T-13b follow-up; DevOps "Admin access" row |

---

## PR workflow

```bash
# 1. Branch from up-to-date main
git checkout main && git pull && git checkout -b feat/T13-admin

# 2. Execute in a worktree (planner)
#    "Use your planner skill to execute plans/T-13-admin-panel.md in a worktree in wt/"
#    State dir: --state-dir .claude/planner-state/T13-$(date +%Y%m%d-%H%M%S)

# 3. Apply migration locally (NOT committed — prisma/migrations gitignored)
npx prisma migrate dev --name add-admin-kyc-review && npx prisma generate

# 4. Verify before PR
npx tsc --noEmit          # clean
npx eslint src/           # clean
npm test -- --run         # all pass

# 5. Open PR against main
#    title: "feat: T-13 — Admin panel (lab KYC review + approval)"
```

Self-review against Implementation Discipline (CLAUDE.md) before merge — key risks: action-level ADMIN re-check (priv-esc), CAS `updateMany`+`count===0`, lab-scoped short-lived GET URL, RSC Decimal/Date serialization, `redirect()` after try/catch, badge maps `satisfies Record`.

---

## After merge

- **T-18 unblocks** (its only remaining blocker was T-13).
- Run the **Compounding Protocol** — patterns queued from T-15 (`import 'server-only'` on client-imported server modules; schema-comment invariants updated in same PR) plus any T-13 pattern. T-13 is a 3+-file PR.
- Update `docs/roadmap.md`: mark T-13 done; re-evaluate T-12 (attachments) vs T-18 (accreditation) as next.
- With `kycStatus=APPROVED` reachable, a real lab can complete PENDING→SUBMITTED→APPROVED and take its first payment through the T-15 gate.
