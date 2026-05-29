# kyc-upload/

KYC document upload slice for labs — presigned PUT URL to Cloudflare R2, tracks lab verification status.

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `upload-action.ts` | Server Action: validates MIME/size, generates presigned PUT URL, creates `LabDocument` row in `PENDING` | Modifying upload validation; debugging presigned URL errors |
| `confirm-action.ts` | Server Action: transitions `LabDocument` `PENDING→UPLOADED` and `Lab.kycStatus` `PENDING→SUBMITTED` atomically | Modifying the confirm step; debugging status transition bugs |
| `page.tsx` | RSC page — reads `Lab.kycStatus` and `LabDocument[]`; passes serialized `KycPageDTO` to `KycUploadUi` | Modifying the KYC page data shape or routing |
| `ui.tsx` | Client component — file picker, two-step upload flow (presigned URL → PUT → confirm), KycStatus badge | Modifying the upload UI or badge display |
| `README.md` | Design decisions — two-step flow, orphan tolerance, admin verification gap | Understanding why the upload flow is structured this way |

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `__tests__/` | Unit tests: upload action, confirm action, KYC gate (both checkout paths) | Adding or debugging tests for this slice |

