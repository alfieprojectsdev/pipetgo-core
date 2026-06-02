# spec-upload — Design Decisions

Slice: CLIENT uploads SPECIFICATION documents to their order via presigned R2 PUT.

## Attachment upload + retrieval — two-step presigned R2 flow (DIAG-001)

### Upload (presigned PUT)

```
CLIENT browser                  Next.js Server Action              Cloudflare R2
      |                                  |                               |
      |-- POST formData (fileName,       |                               |
      |   mimeType, fileSize, orderId) ->|                               |
      |                                  |-- auth() + findUnique(Order) -|
      |                                  |   role+ownership+status check |
      |                                  |-- attachment.create(r2Key)    |
      |                                  |-- generatePresignedPutUrl --> |
      |                                  |<- presignedUrl (300s TTL)     |
      |<- { presignedUrl, attachmentId } |                               |
      |                                  |                               |
      |-- PUT file bytes ---------------------------------->             |
      |   Content-Type bound to signed value                            |
      |<- 200 OK ------------------------------------------------<      |
      |                                  |                               |
      |-- confirmSpecUpload(attachmentId)|                               |
      |   orderId -> updateMany CAS -----+                               |
      |<- revalidatePath                 |                               |
```

### Retrieval (on-demand presigned GET)

```
CLIENT browser                  Next.js Server Action              Cloudflare R2
      |                                  |                               |
      |-- viewOrderAttachment(id) ------->|                               |
      |                                  |-- auth() + findUnique by id   |
      |                                  |   order.clientId ownership    |
      |                                  |   check (type-agnostic)       |
      |                                  |-- generatePresignedGetUrl --> |
      |                                  |<- presignedUrl (300s TTL)     |
      |<- { url }                        |                               |
      |-- GET presignedUrl ------------------------------------->        |
      |<- file bytes -----------------------------------------<         |
```

Key properties: R2 credentials never leave the server. The presigned URL TTL is 300 s — short
enough to bound credential exposure, sufficient for a single user click. The key is loaded from
`Attachment.r2Key` (server-trusted), never from client input.

## Server-trusted r2Key invariant

`Attachment.r2Key` stores the server-generated object key, never a URL. Presigned GETs are
minted on demand (300 s TTL) per authorized access. `r2Key` carries `@unique` to make a
duplicate confirm a DB-level conflict rather than a second row.

## Two-step flow without a status lifecycle

Unlike `LabDocument` (PENDING→UPLOADED→VERIFIED/REJECTED), `Attachment` has no status column.
The flow is: `requestSpecUploadUrl` creates the Attachment row PRE-presign and returns a presigned
PUT URL + `r2Key` + `attachmentId`; the client PUTs the bytes; `confirmSpecUpload` uses CAS
`updateMany {id, orderId}` to acknowledge the upload. Row existence is the "uploaded" signal.
`r2Key @unique` makes a duplicate confirm a no-op conflict.

## Status window — SPEC_UPLOADABLE_STATUSES positive allowlist

`requestSpecUploadUrl` rejects unless `order.status` is a member of the 7-state positive
allowlist `SPEC_UPLOADABLE_STATUSES`:

```
QUOTE_REQUESTED, QUOTE_PROVIDED, PENDING, PAYMENT_PENDING,
PAYMENT_FAILED, ACKNOWLEDGED, IN_PROGRESS
```

Any status NOT in this set — including `COMPLETED`, `CANCELLED`, `QUOTE_REJECTED`,
`REFUND_PENDING`, `REFUNDED`, and any future enum member — is rejected fail-closed.
`QUOTE_REJECTED` is intentionally excluded (no live order). A negative reject-list was
rejected because it would silently permit uploads in `QUOTE_REJECTED` / `REFUND_PENDING` /
`REFUNDED` — all post-fulfillment or dead states where upload must be blocked. (ref: DL-007)

## Ownership guard (TOCTOU)

Every action re-fetches the order and checks `order.clientId === session.user.id` — page/layout
guards do not protect Server Actions. A missing order and a wrong-owner order both return
`Order not found.` (upload-action returns `Unauthorized.` on ownership mismatch) to prevent
information leakage.

## Null relation after explicit select → throw

`order` is fetched via `findUnique`. In `view-attachment-action.ts` the `order` relation is
selected alongside `r2Key`. A null result after an explicit select is a referential integrity
violation, not a missing-row scenario; it throws rather than calling `notFound()`.

## Boundary narrowing

All `formData.get()` calls use `typeof x === 'string'` narrowing — never `as string`.

## Pre-presign row creation — orphan tolerance

The Attachment row is created before the presign call. If the presign fails (R2ConfigError /
R2ValidationError), a friendly message is returned and the orphan row is left in place — the
`r2Key @unique` constraint prevents duplicate rows on retry. The orphan row is benign: no file
exists at the key and no UI will surface it until a successful confirm. (ref: DL-002)

## CLIENT viewer covers all attachment types (DL-011)

`viewOrderAttachment` is intentionally type-agnostic: it serves both SPECIFICATION
and RESULT attachments for the owning CLIENT. The authorization model is
ownership-by-order, not ownership-by-type. Adding a SPECIFICATION-only filter
would block the CLIENT from downloading RESULT PDFs — an intended access path.
