# accreditation-upload/

ISO 17025 accreditation certificate upload slice for labs — presigned PUT to Cloudflare R2,
lab-side status surfacing. Cloned from `kyc-upload/`. Does not transition `kycStatus`.

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `upload-action.ts` | Server Action: validates MIME/size/documentType, generates presigned PUT URL, creates `LabDocument` row in `PENDING` | Modifying upload validation; debugging presigned URL errors |
| `confirm-action.ts` | Server Action: transitions `LabDocument` `PENDING→UPLOADED` via CAS `updateMany` | Modifying the confirm step; debugging status transition bugs |
| `page.tsx` | RSC page — reads `Lab.isVerified`, `Lab.accreditationRejectionReason`, and `LabDocument[]` for the cert; passes `AccreditationPageDTO` to `AccreditationUploadUi` | Modifying the page data shape or routing |
| `ui.tsx` | Client component — file picker, two-step upload flow, accreditation status badge, rejection reason banner | Modifying the upload UI or badge display |
| `README.md` | Design decisions — clone rationale, isVerified vs kycStatus, two-step flow, LabDocument vs Attachment, documentType allowlist, boundary narrowing | Understanding why the upload flow is structured this way |

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `__tests__/` | Unit tests for `upload-action.ts` and `confirm-action.ts` | Adding or debugging tests for this slice |
