# result-upload — Design Decisions

Slice: LAB_ADMIN uploads RESULT documents to an order via presigned R2 PUT.
Cloned from spec-upload and adapted for LAB_ADMIN role, 50 MB limit, PDF-only MIME.

## Server-trusted r2Key invariant

`Attachment.r2Key` stores the server-generated object key, never a URL. Presigned GETs are
minted on demand (300 s TTL) per authorized access. `r2Key @unique` ensures a duplicate confirm
is a DB-level conflict rather than a second row.

## Two-step flow with pre-presign Attachment creation

`requestResultUploadUrl` creates the `Attachment` row PRE-presign, then returns a presigned
PUT URL + `r2Key` + `attachmentId`; the client PUTs the bytes; `confirmResultUpload` performs
a CAS `attachment.updateMany {id, orderId}` as the idempotency guard. Row existence is the
uploaded signal. `r2Key @unique` is the concurrency guard.

## Ownership guard (TOCTOU)

Every action re-fetches the order and checks `order.lab.ownerId === session.user.id` —
page/layout guards do not protect Server Actions. `order.lab` is fetched via explicit select;
if null after select, it throws (referential integrity violation, not a 404 scenario).

## 50 MB limit, PDF-only, 120 s PUT timeout

Result documents are PDF-only (`RESULT_MIME_TYPES = ['application/pdf']`). The 50 MB limit
uses `MAX_RESULT_BYTES` from `src/lib/storage/constants.ts`, threaded through both the action
check and the `generatePresignedPutUrl` call so R2 does not reject the upload. `ResultUploadUi`
sets `AbortSignal.timeout(120_000)` on the browser `fetch` PUT — double the 60 s used by
spec-upload — because RESULT files can reach 50 MB and a slow mobile upload must not be
cancelled prematurely.

## RESULT type only — IN_PROGRESS-only window

`requestResultUploadUrl` rejects unless `order.status === 'IN_PROGRESS'` (single positive
equality check). Result documents represent formal deliverables with ITA result-integrity
liability; attaching them before or after the active processing window is disallowed.

## Clone rationale

Two separate slices (`spec-upload`, `result-upload`) rather than one parameterized slice:
different role guards, different type allowlists, different size limits, different MIME sets.

## LAB_ADMIN reads CLIENT specs through this slice via SpecAttachmentListUi (DL-009, DL-011)

`viewResultAttachment` is type-agnostic — it gates solely on `order.lab.ownerId === session.user.id`,
not on `attachmentType`. A LAB_ADMIN can therefore call it to mint a presigned GET for any
attachment on a lab's own order, including SPECIFICATION attachments uploaded by the CLIENT.
`SpecAttachmentListUi` (exported from `ui.tsx`) surfaces those SPECIFICATION attachments to the
LAB_ADMIN on the lab-fulfillment page with View buttons that invoke `viewResultAttachment`. This
mirrors the DL-011 ownership-by-order (not by-type) authorization model on the lab side — the
same principle governs `viewOrderAttachment` in the spec-upload slice on the client side.
Cross-slice viewer import remains prohibited by ADR-001; each slice owns its authorization
predicate independently (DL-009).
