# T-15 Implementation Session — Complete

**Date:** 2026-05-29  
**PR:** #16 — merged `dadbbdf` (squash commit on main)  
**Branch:** `feat/T15-lab-kyc-upload` (deleted post-merge)  
**Worktree:** `wt/T15-lab-kyc-upload` (remove with `git worktree remove wt/T15-lab-kyc-upload --force`)

---

## What happened this session

Full planner executor cycle completed for T-15:

**Wave 1 (parallel):**
- M1 — `src/lib/storage/r2.ts` + `src/lib/storage/constants.ts`: R2 client, `generatePresignedPutUrl`, env config validation, MIME/size allowlist
- M2 — `prisma/schema.prisma`: `KycStatus` + `DocumentStatus` enums, `LabDocument` model, `Lab.kycStatus`, `Lab.ownerId @unique`, `findFirst→findUnique` in onboarding + service-management

**Wave 2 (parallel):**
- M3 — `src/features/labs/kyc-upload/`: upload-action, confirm-action, page, ui, CLAUDE.md, route page
- M4 — `src/features/payments/checkout/action.ts`: KYC gate on both `initiateCheckout` and `initiateVaCheckout`

**Wave 3:**
- M5 — 4 unit test suites, 36 tests all pass (`vitest.unit.config.ts` added for Neon-less unit run)

**Review (same session):**
- 7-angle code review + CodeRabbit first-pass addressed
- Follow-up commit `0859dd7`: 16 files changed (server-only guard, silent upload errors, stale findMany, order-detail UX gate, lint, docs)
- Follow-up commit `2d97da6`: checkout README flow diagrams + markdown lint

---

## Plan deviations (intentional)

| Plan spec | Actual | Reason |
|-----------|--------|--------|
| `r2.ts` exports `ALLOWED_MIME_TYPES` + `MAX_BYTES` | Extracted to `constants.ts`; `r2.ts` re-exports | `'server-only'` guard added — client component (`ui.tsx`) can't import from guarded module |
| `upload-action.ts` `_prev: ActionState` | Widened to `ActionState \| UploadResult` | `useActionState` passes prior return value back as state — narrower type caused tsc error |
| `ui.tsx` explicit `useActionState<…, FormData>` generics | Generics removed; initial state cast used | `FormData` generic caused TypeScript to resolve wrong `useActionState` overload |
| `vitest.unit.config.ts` not in plan | Added | Neon test DB unreachable from this host; unit tests need to run without `globalSetup` |
| `src/test/server-only-mock.ts` not in plan | Added | `server-only` throws in Vitest; mock redirects the import to a no-op export |

---

## Review findings fixed

| Finding | Severity | Fix |
|---------|----------|-----|
| `r2.ts` imported by `ui.tsx` without `server-only` — AWS SDK bundled to client | CONFIRMED | Extracted constants to `constants.ts`; added `import 'server-only'` to `r2.ts` |
| `!putRes.ok` returns silently; `catch{}` swallows `TimeoutError` | CONFIRMED | `putError` state set on failure; catch sets error message |
| `findMany` on `@unique` `Lab.ownerId` in `wallet/page.tsx` and `service-management/action.ts` | PLAUSIBLE | Replaced with `findUnique`; stale `@@index but NOT @@unique` comments removed |
| Stale `@@index but NOT @@unique` comments in dashboard/page.tsx, wallet/page.tsx, dashboard/README.md | CONFIRMED | Updated to reflect `@unique` |
| `validateSize` accepts NaN/0/negative | CodeRabbit | Added `!Number.isFinite(contentLength) \|\| contentLength <= 0` guard |
| `buildS3Client` no `requestTimeout` | New finding | Added `requestHandler: { requestTimeout: 10_000 }` |
| `order-detail` VA bank selector shown for non-APPROVED labs | CONFIRMED (UX) | `labKycApproved: boolean` added to `OrderDetailDTO`; selector gated |
| Unused `prisma` import in `confirm-action.test.ts` | CodeRabbit lint | Removed |
| `CLAUDE.md` wrong test dir for `kyc-gate.test.ts` | CodeRabbit | Fixed to point to `checkout/__tests__/` |
| `src/app/dashboard/lab/kyc/page.tsx` missing from first commit | Bug | Staged and committed in follow-up |

**Not fixed (accepted design):**
- `confirmUpload` trusts DB state, not R2 existence — intentional per DL-018; manual admin review (T-13) is the appropriate gate
- `User.labs Lab[]` vs `Lab?` — REFUTED; Prisma 5.22 generates cleanly with `Lab[]`; existing call sites use array

---

## Open items (not code)

| Item | Urgency |
|------|---------|
| R2 CORS policy: allow `PUT` from `https://<domain>` and `http://localhost:3000` | **Required before first upload** |
| Five R2 env vars added to Vercel (production + preview) | Required before deploy |
| `npx prisma migrate dev --name add-lab-kyc-status` run locally if dev DB is available | Before integration tests |

---

## Compounding Protocol — two new patterns extracted

1. **Server modules imported by client components must have `import 'server-only'`** — `r2.ts` had no guard and `ui.tsx` (`'use client'`) imported from it, bundling AWS SDK to the browser. Fix pattern: extract pure-data constants to a `constants.ts` sibling (no guard); add `'server-only'` to the module with Node/env code.

2. **Schema comments asserting an invariant must be updated in the same PR that changes the invariant** — three files had `@@index but NOT @@unique` comments that T-15 made false. The implementation correctly added `@unique` but did not sweep the prose.

> Run `compounding protocol` after T-13 or the next PR that touches 3+ files to capture these as CLAUDE.md bullets.

---

## Next tickets

| Ticket | Status | Notes |
|--------|--------|-------|
| **T-13 Admin panel** | ready (priority↑) | Needed to set `kycStatus=APPROVED` — the only blocker preventing labs from receiving payments through the T-15 gate. Also gates T-18. |
| **T-12 Attachment uploads** | ready (newly unblocked) | R2 provisioned; `src/lib/storage/r2.ts` ready to reuse for client spec + lab result PDFs. |
| **T-19 Dispute / redress** | ready | ITA 2023 compliance; no new dependencies. Schema migration needed (`DISPUTED` status). |
