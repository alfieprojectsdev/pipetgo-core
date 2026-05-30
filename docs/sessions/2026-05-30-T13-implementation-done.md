# T-13 Implementation Session — Merge + Local Deploy

**Date:** 2026-05-30
**PR:** #17 — merged `2e9c8cc` (squash commit on main)
**Branch:** `feat/T13-admin` (deleted post-merge, local + remote)
**Worktree:** `wt/T13-admin` (removed post-merge)

---

## What happened this session

Full planner executor cycle for T-13 (admin KYC review surface), then CodeRabbit
triage, merge, and local deploy + DB bootstrap.

**Executor waves (worktree `wt/T13-admin`):**
- W1 — M1: `prisma/schema.prisma` Lab audit columns (`kycReviewedById`,
  `kycReviewedAt`, `kycRejectionReason`) + `reviewer` named relation; `src/lib/storage/r2.ts`
  `generatePresignedGetUrl` (300s TTL, `labs/` prefix guard) + tests.
- W2 (parallel) — M2: `src/features/admin/kyc-review/` (queue + detail RSC,
  `approveOrRejectKyc` CAS + doc cascade, `viewKycDocument` on-click presigned GET,
  badges, CLAUDE.md, README.md, 2 test suites); M3: lab-side rejection-reason banner
  in `src/features/labs/kyc-upload/`.
- W3 — M4: `/dashboard/admin` route group + layout guard + thin re-exports + roadmap
  DevOps checklist.
- Code QR: PASS. Doc QR: PASS after 2 fix rounds. 51 unit tests, tsc clean.

**CodeRabbit (commit `98a0110`):** 10 comments triaged against Implementation Discipline.
8 fixed, 2 skipped with reason (see table). Independent quality-reviewer PASS on the
fix delta. Squash-merged.

**Local deploy + bootstrap (dev Neon `neondb`):**
- Schema applied via `npx prisma db push --accept-data-loss` — NOT `migrate dev` (dev DB
  is a db-push workflow; T-15 LabDocument has no migration file, so `migrate dev` would
  drift/reset). 3 audit columns verified on `labs`. Also synced a pre-existing
  `Lab.ownerId @unique` constraint — harmless, DB was empty.
- `npm install` in main repo — `node_modules` was missing `tailwindcss` + `autoprefixer`
  (declared in package.json but never installed); every route 500'd on the globals.css
  Tailwind import until installed.
- `npx next dev` (no `dev` script in package.json) → localhost:3000.
- Admin bootstrapped: `alfieprojects.dev@gmail.com` signed in via Google, then promoted
  `CLIENT → ADMIN` (1 row). Session = JWT strategy; the `jwt` callback re-reads role from
  DB on token refresh, so ADMIN propagates on next navigation (hard-refresh if stale).

---

## CodeRabbit findings — triaged against Implementation Discipline

| Finding | Sev | Verdict |
|---------|-----|---------|
| `action.ts` FormData `as string` + `$transaction` no try/catch | Major | Fixed — `typeof` coercion (File-safe); wrap `$transaction`, rethrow with context; `redirect`/`revalidatePath` kept outside catch |
| `detail-page.tsx` / `page.tsx` `email ?? ''` masking non-null field | Major/Minor | Fixed — removed fallback (`User.email` non-null) |
| `view-document-action.ts` Prisma+R2 no error handling | Major | Fixed — wrap, return stable `{ message }` |
| `detail-ui.tsx` ignores `viewKycDocument` error branch | Major | Fixed — surface error near View button |
| `labs/kyc-upload/page.tsx` REJECTED-lab null reason silent | Major | Fixed — throw invariant breach (DL-006) |
| roadmap `PR #TBD`; README "full page" hyphen | Minor | Fixed — quick wins |
| `layout.tsx` non-admin → `/auth/signin` | Minor | **Skipped** — plan DL-001 + lab-fulfillment precedent deliberately redirect signin |
| `ui.tsx` `toLocaleDateString` hydration | Minor | **Skipped** — matches existing repo date-render pattern; locale/TZ ambiguous; out of requested severity |

---

## Environment gotchas (not code)

| Item | Detail |
|------|--------|
| **CSS "missing" was a false alarm** | Tailwind works: clean pipetgo server serves a 43 KB `/_next/static/css/app/layout.css` with all utilities. The unstyled view was a **rogue `next-server v16` (PID 2126, a different project) holding port 3000**, plus likely browser cache from the pre-`npm install` 500 phase. Fix: run pipetgo on its own port and hard-refresh; don't share 3000 with the v16 app. |
| `tailwindcss` + `autoprefixer` not installed | Declared in package.json but absent from main-repo `node_modules`. `npm install` fixed. |
| No `dev` script | Run `npx next dev` directly. |
| `/` is 404 | No root landing page — entry at `/auth/signin`. |
| Auth env in `.env.local` | `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`; `DATABASE_URL` in `.env`. Google redirect URI must be `http://localhost:3000/api/auth/callback/google`. |

---

## Pending DevOps (other environments)

- Apply T-13 audit columns per-env (CI / prod Neon branches): `npx prisma db push` (or
  `migrate dev` only if that env actually uses migration history). `prisma/migrations` is
  gitignored (DL-011); `schema.prisma` is the committed source of truth.
- Bootstrap the first admin per-env: `UPDATE "users" SET role='ADMIN' WHERE email='<email>';`
  (DL-008; no in-app promotion path).

---

## Next tickets

| Ticket | Status | Notes |
|--------|--------|-------|
| **T-18 Lab accreditation verification** | **ready (just unblocked by T-13)** | ITA 2023 / ISO 17025 solidary-liability. Reuses the admin slice + auth patterns just built; operates `Lab.isVerified` (the gate the T-13 README explicitly distinguishes from `kycStatus`). ~2 sessions. **Recommended next.** |
| T-12 Attachment uploads | ready | Reuses `src/lib/storage/r2.ts` (presigned GET added in T-13). Client spec + lab result PDFs. ~3 sessions (heavier). |
| T-13b Admin role mgmt + order oversight | follow-up | Spun out of T-13. Privilege-escalation surface — needs its own audit focus. |
| T-19 Dispute and redress | ready | ITA 2023 internal redress; schema migration needed (`DISPUTED` status). ~2 sessions. |

> Run `compounding protocol` after T-13 (PRs #15–#18 window per CLAUDE.md) to extract
> CLAUDE.md bullets from this batch.
