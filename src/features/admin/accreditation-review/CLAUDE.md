# accreditation-review/

Admin ISO 17025 accreditation review slice — queue of unverified labs with a pending cert,
per-lab detail with document viewing, and verify/reject CAS action. Cloned from `kyc-review/`.

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `page.tsx` | RSC queue page — fetches labs where `isVerified=false` AND an UPLOADED `ACCREDITATION_CERTIFICATE` LabDocument exists; renders `AdminAccreditationQueueUi` | Modifying queue filter or ordering |
| `detail-page.tsx` | RSC detail page — fetches a single lab with owner + accreditation docs; passes `LabAccreditationDetailDTO` to `AdminAccreditationDetailUi` | Modifying detail data shape or routing |
| `action.ts` | `verifyOrRejectAccreditation` — ADMIN-gated server action; boolean CAS on `isVerified=false`; doc cascade scoped to `ACCREDITATION_CERTIFICATE`; redirects after transaction | Modifying verify/reject flow, CAS logic, or audit fields |
| `view-document-action.ts` | `viewAccreditationDocument` — ADMIN-gated; loads `r2Key` from DB; returns 300s presigned GET URL | Modifying document viewing; debugging presigned URL issues |
| `ui.tsx` | `AdminAccreditationQueueUi` — table of pending labs with Review links | Modifying the queue table layout |
| `detail-ui.tsx` | `AdminAccreditationDetailUi` — document list with view buttons, verify form, reject form with reason textarea | Modifying the review UI or form layout |
| `README.md` | Design decisions — clone rationale, two-layer auth, boolean CAS, scoped cascade, queue filter, on-click presigned GET | Before changing auth or state-transition logic |

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `__tests__/` | Unit tests for `action.ts` and `view-document-action.ts` | Adding or debugging tests for this slice |
