# spec-upload/

CLIENT SPECIFICATION document upload slice — presigned PUT to Cloudflare R2, on-demand presigned GET.

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `upload-action.ts` | `requestSpecUploadUrl` — CLIENT-only; validates MIME/size, generates presigned PUT URL, creates Attachment row pre-presign | Modifying upload validation or presign logic |
| `confirm-action.ts` | `confirmSpecUpload` — CLIENT-only; CAS `attachment.updateMany {id, orderId}`, count===0 early-return | Modifying confirm step |
| `view-attachment-action.ts` | `viewOrderAttachment` — CLIENT-only; re-checks ownership via order.clientId, mints 300s presigned GET | Modifying view/download |
| `ui.tsx` | `SpecUploadUi` — file picker, two-step upload, attachment list with View buttons | Modifying upload UI |
| `README.md` | Design decisions: server-trusted r2Key, pre-presign row, statusless flow, ownership guards, boundary narrowing | Understanding why this slice is structured this way |

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `__tests__/` | Unit tests for upload-action, confirm-action, view-attachment-action | Adding or debugging tests |

## Invisible knowledge

`viewOrderAttachment` serves both SPECIFICATION and RESULT attachments for the CLIENT owner (DL-011). See README.md.
