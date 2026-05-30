# kyc-review/

Admin KYC review slice — queue of SUBMITTED labs, per-lab detail with document viewing, and approve/reject action.

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `page.tsx` | RSC queue page — fetches SUBMITTED labs ordered by `Lab.createdAt asc` (creation order, FIFO proxy), renders `AdminKycQueueUi` | Modifying the queue data shape or ordering |
| `detail-page.tsx` | RSC detail page — fetches a single lab with owner + documents, passes `LabKycDetailDTO` to `AdminKycDetailUi` | Modifying the detail data shape or routing |
| `action.ts` | `approveOrRejectKyc` — ADMIN-gated server action; CAS on `kycStatus=SUBMITTED`; updates Lab + LabDocument atomically; redirects after transaction | Modifying the approve/reject flow, CAS logic, or audit fields |
| `view-document-action.ts` | `viewKycDocument` — ADMIN-gated; loads `r2Key` from DB; returns presigned GET URL | Modifying document viewing; debugging presigned URL issues |
| `ui.tsx` | `AdminKycQueueUi` — table of pending labs with Review links | Modifying the queue table layout |
| `detail-ui.tsx` | `AdminKycDetailUi` — document list with view buttons, approve form, reject form with reason textarea | Modifying the review UI, form layout, or document viewer |
| `README.md` | Design decisions — two-layer auth, TOCTOU CAS, on-click presigned GET, queue ordering | Before changing auth or state-transition logic — two-layer auth/TOCTOU, CAS-on-SUBMITTED, on-click presigned GET, kycStatus-vs-isVerified distinction, queue ordering, first-admin bootstrap, migrations-not-committed |

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `__tests__/` | Unit tests for `action.ts` and `view-document-action.ts` | Adding or debugging tests for this slice |
