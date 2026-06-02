# result-upload/

LAB_ADMIN RESULT document upload slice — presigned PUT to Cloudflare R2, on-demand presigned GET.

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `upload-action.ts` | `requestResultUploadUrl` — LAB_ADMIN-only; PDF-only MIME allowlist; 50 MB limit; generates presigned PUT, creates Attachment row pre-presign | Modifying upload validation or presign logic |
| `confirm-action.ts` | `confirmResultUpload` — LAB_ADMIN-only; re-checks ownership via order.lab.ownerId; CAS `attachment.updateMany {id, orderId}` | Modifying confirm step |
| `view-attachment-action.ts` | `viewResultAttachment` — LAB_ADMIN-only; re-checks ownership via order.lab.ownerId, mints 300s presigned GET | Modifying view/download |
| `ui.tsx` | `ResultUploadUi` — file picker, two-step upload, RESULT attachment list with View buttons; `SpecAttachmentListUi` — read-only LAB_ADMIN-facing list of the order's SPECIFICATION attachments with View buttons via `viewResultAttachment` (rendered on the lab-fulfillment page) | Modifying upload UI or the spec-list display for LAB_ADMIN |
| `README.md` | Design decisions: clone-from-spec-upload rationale, LAB_ADMIN guard, 50 MB limit, PDF-only, IN_PROGRESS-only window | Understanding why this slice is structured this way |

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `__tests__/` | Unit tests for upload-action, confirm-action, view-attachment-action | Adding or debugging tests |

## Invisible knowledge

This slice does not cross-import from spec-upload. Each slice owns its authorization predicate independently (DL-009). See README.md.
