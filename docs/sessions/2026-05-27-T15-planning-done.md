# T-15 Planning Session — Complete

**Date:** 2026-05-27  
**Branch to create:** `feat/T15-lab-kyc-upload`  
**Plan file:** `plans/T-15-lab-kyc-upload.md` (2,456 lines, QR-verified)  
**State dir (expired):** `/tmp/planner-0w8ghpd6` — not needed for implementation

---

## What happened this session

Full planner orchestrator cycle completed (QR + TW phases) for T-15:
- plan-design QR: PASS (2 fix iterations — `generatePresignedGetUrl` DL gap, `findFirst` on promoted `@unique` field, documentType allowlist DL)
- plan-code QR: PASS (4 fix iterations — duplicate schema diff, broken upload flow, hunk header accuracy, `findFirst→findUnique` migration coverage)
- plan-docs QR: PASS (5 fix iterations — temporal contamination strings, ticket references in stable docs)

21 `code_changes` registered across 5 milestones. The plan file is the authoritative implementation spec — read it before starting.

**User decisions captured during planning:**
- **KYC gate location:** checkout-only (both `initiateCheckout` and `initiateVaCheckout`) — settlement handler stays untouched
- **Xendit KYC API:** deferred to T-13 manual admin review — no Xendit API call in this slice

---

## Pre-session checklist (REQUIRED before any code)

R2 must be provisioned before the first implementation session. Without these, the storage client cannot be tested locally.

| Step | Action |
|------|--------|
| 1 | Create Cloudflare R2 bucket in APAC region |
| 2 | Create API token with **Object Read & Write** on that bucket only |
| 3 | Set CORS policy: allow `PUT` from `https://<domain>` and `http://localhost:3000` |
| 4 | Add 5 env vars to `.env.local` and Vercel (see below) |
| 5 | Run `npx prisma migrate dev --name add-lab-kyc-status` locally |

**Required env vars:**
```
CLOUDFLARE_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_ENDPOINT=https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com
```

---

## Implementation starting point

### Files to CREATE (new)

| File | What |
|------|------|
| `src/lib/storage/r2.ts` | Cloudflare R2 presigned PUT URL client — `generatePresignedPutUrl(key, contentType, contentLength)` |
| `src/lib/storage/README.md` | Directory CLAUDE.md for storage lib |
| `src/lib/storage/__tests__/r2.test.ts` | Unit tests — mocks S3Client at SDK boundary |
| `src/features/labs/kyc-upload/upload-action.ts` | Server Action: validates MIME/size, generates presigned PUT URL, creates `LabDocument` row in PENDING |
| `src/features/labs/kyc-upload/confirm-action.ts` | Server Action: marks `LabDocument` UPLOADED, transitions `Lab.kycStatus` PENDING→SUBMITTED if first upload |
| `src/features/labs/kyc-upload/page.tsx` | RSC page at `/dashboard/lab/kyc` — shows `Lab.kycStatus`, existing LabDocuments, upload form |
| `src/features/labs/kyc-upload/ui.tsx` | Client component — file picker, MIME pre-check, two-step upload flow (presigned URL → PUT → confirm) |
| `src/features/labs/kyc-upload/CLAUDE.md` | Slice invariants and schema migration convention |
| `src/app/dashboard/lab/kyc/page.tsx` | Route re-export |
| `src/features/labs/kyc-upload/__tests__/upload-action.test.ts` | Unit tests: R2 error, MIME rejection, owner guard |
| `src/features/labs/kyc-upload/__tests__/confirm-action.test.ts` | Unit tests: CAS guard, SUBMITTED transition, idempotent re-confirm |
| `src/features/labs/kyc-upload/__tests__/r2.test.ts` | Unit tests for r2.ts |
| `src/features/labs/kyc-upload/__tests__/kyc-gate.test.ts` | Unit tests: checkout gate for PENDING/SUBMITTED/APPROVED/REJECTED |

### Files to MODIFY

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `KycStatus` enum, `DocumentStatus` enum, `LabDocument` model, `Lab.kycStatus KycStatus @default(PENDING)`, `Lab.ownerId @unique`, `Lab.documents LabDocument[]`, `User.labDocuments LabDocument[]` |
| `src/features/payments/checkout/action.ts` | Add KYC gate before `createXenditInvoice` and before `createXenditVa` — return error if `lab.kycStatus !== APPROVED` |
| `src/features/labs/onboarding/action.ts` | Migrate `prisma.lab.findFirst({ where: { ownerId } })` → `findUnique` (Lab.ownerId is now `@unique`) |
| `src/features/labs/service-management/page.tsx` | Same `findFirst → findUnique` migration on `ownerId` lookup |
| `package.json` | Add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` |

---

## Critical gotchas discovered during planning

### 1. `Lab.ownerId` is promoted to `@unique` — migrate all `findFirst` callers
T-15 adds `@unique` to `Lab.ownerId` per DL-015. Two existing files use `prisma.lab.findFirst({ where: { ownerId } })` — they must become `findUnique` in the same PR (Implementation Discipline: `findFirst` on `@unique` fields violates the contract). Files: `src/features/labs/onboarding/action.ts:39` and `src/features/labs/service-management/page.tsx:10`.

### 2. New `LabDocument` model — do NOT touch `Attachment.orderId`
`Attachment.orderId` is `String` (NOT NULL). KYC docs have no Order — they cannot use the existing `Attachment` model without making `orderId` nullable (Option A, rejected). T-15 adds a new `LabDocument` model (Option B). Do not modify `Attachment`.

### 3. `Lab.isVerified` is reserved for T-18 — do not touch
`Lab.isVerified Boolean @default(false)` is the T-18 ISO 17025 accreditation field. T-15 adds `Lab.kycStatus KycStatus` (a separate field for payment gateway verification). These are two distinct concepts — KYC ≠ ISO 17025 accreditation.

### 4. Two-step upload flow — `useEffect` pattern required in ui.tsx
The UI component calls `uploadAction(fd)` via `useActionState`, then a `useEffect` on `[uploadState]` detects the `presignedUrl` in the result and executes the R2 PUT + `confirmUpload`. A direct `await uploadAction(fd)` inside `handleSubmit` would not work — `useActionState` is async and `handleSubmit` cannot await the action's returned value synchronously.

### 5. Presigned PUT URL is 300s TTL — confirm-action is idempotent
If the R2 PUT succeeds but `confirmUpload` fails, the client may retry `confirmUpload`. The confirm action uses `updateMany({ where: { id, status: 'PENDING' } })` + `count === 0` early-return — safe to call twice.

### 6. Orphan LabDocument rows are a tolerated cost — do not add cleanup here
If the client creates a presigned URL but never uploads, a `LabDocument` row with `status = PENDING` remains. Cleanup is a separate GC ticket. Do not add TTL or deletion logic in this slice.

### 7. MIME allowlist is server-side string constant — no Prisma enum
`DOCUMENT_TYPE_ALLOWLIST = ['BIR_2303', 'DTI_SEC', 'OTHER'] as const` in `upload-action.ts`. `documentType` is a `String` column on `LabDocument` (not a Prisma enum) so new document kinds can be added by extending the constant — no schema migration needed.

### 8. KYC gate returns an ActionState error — does NOT redirect
`initiateCheckout` and `initiateVaCheckout` return `{ errors: { _form: ['Lab KYC not approved. ...'] } }` when `kycStatus !== APPROVED`. They do NOT throw. The order-detail UI must display this error inline. The `redirect()` calls remain untouched after the gate (Implementation Discipline: `redirect()` after — never inside — try/catch).

### 9. `@aws-sdk/client-s3` requires Node.js runtime — not Edge
R2 presigned URL generation uses the AWS SDK which requires Node.js. Ensure `export const runtime = 'nodejs'` or no runtime override in the upload action file. Next.js defaults to Node.js for Server Actions, so this is a no-op unless Edge was explicitly set.

---

## Implementation Discipline reminders

- `findUnique` on `@unique` fields — never `findFirst` (Lab.ownerId is now `@unique`)
- `updateMany` with status guard + `count === 0` check for confirm-action CAS (ref: implementation discipline rule #3)
- `redirect()` after — never inside — try/catch in Server Actions
- Null relation after explicit `include` must `throw` — never `notFound()`
- RSC DTOs: `Decimal` → `.toFixed(2)`, `Date` → `.toISOString()` (applies to page.tsx KycPageDTO)
- Unhandled `KycStatus` or `documentType` must `throw` — never default silently
- `AbortSignal.timeout(10_000)` is NOT needed on presigned URL generation (local SDK call) — but IS needed if any future Xendit KYC API call is added

---

## PR workflow

```bash
# 1. Provision R2 (non-engineering — see pre-session checklist above)

# 2. Apply migration locally
npx prisma migrate dev --name add-lab-kyc-status

# 3. Install new deps
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

# 4. Branch and implement
git checkout -b feat/T15-lab-kyc-upload

# 5. Implement in wave order:
#    Wave 1 (parallel): M-001 src/lib/storage/r2.ts + M-002 prisma/schema.prisma
#    Wave 2 (parallel): M-003 src/features/labs/kyc-upload/ + M-004 checkout gate
#    Wave 3: M-005 tests

# 6. Verify before PR
npx tsc --noEmit          # must be clean
npx eslint src/           # must be clean
npm test -- --run         # all tests must pass

# 7. Open PR against main
```

PR title: `feat: T-15 — Lab KYC document upload (Cloudflare R2 + checkout gate)`
<!-- claude --resume a481d686-df1c-400b-87e5-21fc304ee68d -->
