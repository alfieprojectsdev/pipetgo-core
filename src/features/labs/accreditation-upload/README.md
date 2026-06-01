# accreditation-upload — Design Decisions

## Slice origin — cloned from kyc-upload (DL-001)

This slice is a sibling clone of `labs/kyc-upload/`, not a parameterised extension.
`kyc-upload/confirm-action` transitions `Lab.kycStatus PENDING → SUBMITTED`; accreditation
has no equivalent lifecycle enum — only the `isVerified` boolean, which is set exclusively
by the admin verify action. Parameterising a single slice would couple the live KYC
payment gate to a flow that has no status transition and would require reproducing the
`kycStatus` guard logic. Clone risk is lower than coupling risk.

## isVerified vs kycStatus (C-002)

`Lab.kycStatus` is the **payment-gateway KYC gate** (T-15/T-13).
`Lab.isVerified` is the **ISO 17025 accreditation / ITA 2023 marketplace gate** (T-18).
`confirmUpload` does **not** transition `kycStatus` and does **not** set `isVerified`.
`isVerified` is admin-only; this slice only advances the cert `LabDocument` from
`PENDING` to `UPLOADED`.

## Two-step upload (DL-001 pattern from kyc-upload)

1. `requestUploadUrl` validates MIME/size, creates a `LabDocument` row in `PENDING`, returns
   a presigned R2 PUT URL + `labDocumentId`.
2. The browser PUTs the file directly to R2.
3. `confirmUpload` advances `LabDocument PENDING → UPLOADED` via `updateMany` with a
   `{id, labId, status: 'PENDING'}` guard. `count === 0` means the doc was already confirmed
   or the wrong lab — idempotent early-return.

## LabDocument, not Attachment (DL-002)

`Attachment.orderId` is `NOT NULL` (order-scoped). Accreditation is lab-level: a cert has
no order to bind to. `LabDocument` (introduced in T-15) is already lab-scoped and reused
for KYC. The dead `AttachmentType.ACCREDITATION_CERTIFICATE` enum value stays unwired.

## documentType allowlist (C-012)

`requestUploadUrl` validates `documentType` against `DOCUMENT_TYPE_ALLOWLIST`. An unknown
value throws rather than silently inserting an unrecognised type. The allowlist mirrors the
`documentType` field on `LabDocument` (a String column, not a Prisma enum — per DL-016 in
`kyc-upload/README.md`).

## Boundary input narrowing (DL-008)

All `formData.get(…)` calls are typeof-narrowed (`typeof x === 'string' ? x : null`).
`kyc-upload/upload-action.ts` uses `as string` coercion; `as string` masks the null case
because `FormData.get` returns `FormDataEntryValue | null`. The canonical boundary-handling
source for this slice is `admin/kyc-review/action.ts`. (ref: DL-008)

## Orphan rows tolerated

A `PENDING` `LabDocument` row is left if the client abandons after `requestUploadUrl` but
before PUT or confirm. A future GC sweep handles both the DB row and R2 object. No cleanup
logic belongs in this slice.

## Rejection reason surfacing (DL-011)

`AccreditationPageDTO` carries `accreditationRejectionReason` from `Lab`. The UI renders
a banner when `!isVerified && accreditationRejectionReason !== null` so the lab owner knows
what to correct before re-uploading — mirrors the T-13 M-003 lab-side banner pattern.
