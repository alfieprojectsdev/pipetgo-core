# Plan

## Overview

Order artifact loop is incomplete: a CLIENT cannot attach SPECIFICATION documents to an order and a LAB_ADMIN cannot deliver RESULT PDFs in-app. T-12 wires the existing-but-unused order-scoped Attachment model to Cloudflare R2 (presigned PUT + on-demand presigned GET), closing the loop between order-placed and results-delivered.

**Approach**: Two thin VSA slices under src/features/orders (spec-upload CLIENT/SPECIFICATION/20MB on order-detail; result-upload LAB_ADMIN/RESULT/50MB on lab-fulfillment) sharing parameterized presign/validate logic in src/lib/storage; one view/download action minting a 300s presigned GET per authorized access; Attachment gains r2Key String @unique storing the server-trusted key. ACCREDITATION_CERTIFICATE stays dead.

### Attachment upload + retrieval — two-step presigned R2 flow

[Diagram pending Technical Writer rendering: DIAG-001]

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Add Attachment.r2Key String @unique storing the server-trusted R2 object key, never persist a URL in fileUrl; AND make the existing fileUrl column optional (fileUrl String -> fileUrl String?) so the pre-presign create that omits it succeeds | fileUrl's name is a trap and presigned URLs expire (300s) while a public URL leaks the object indefinitely -> the server-trusted key + on-demand presigned GET pattern (LabDocument.r2Key + generatePresignedGetUrl) is the established invariant -> add r2Key @unique to mirror LabDocument exactly, giving uniqueness-based idempotency and a self-documenting column. fileUrl is currently NOT NULL (schema.prisma:266) with no @default, but the pre-presign Attachment.create() supplies r2Key and never fileUrl -> leaving fileUrl required would make every create() fail at compile time and at the DB constraint -> change fileUrl to String? so it stays permanently unused/unwritten without breaking inserts; do not backfill a dummy URL |
| DL-002 | Pre-presign row creation (RowTiming): create the Attachment row BEFORE presigning, carrying the server-generated r2Key; confirm is an idempotent no-op acknowledgment | user decision RowTiming -> Attachment has no status lifecycle so confirm has nothing to advance -> mirror accreditation-upload (row created pre-presign) minus the status column; r2Key @unique is the sole concurrency guard (no CAS updateMany), orphan rows on abandoned uploads tolerated exactly as kyc-upload tolerates them; confirm re-checks ownership and revalidatePath only |
| DL-003 | Two thin VSA slices orders/spec-upload (CLIENT/SPECIFICATION/20MB) and orders/result-upload (LAB_ADMIN/RESULT/50MB); shared logic only in src/lib/storage, never cross-slice imported; badge/type maps copied per slice | two actors with different role/ownership guards, size limits and MIME allowlists but identical presign mechanics -> a single parameterized slice would branch on role inside one action, muddying the TOCTOU guard -> two slices keep one-slice-one-workflow (ADR-001/VSA), each owning its guard; shared validation/presign lives in src/lib/storage |
| DL-004 | Parameterize r2.ts prefix and size guards via an explicit allowedPrefix and maxBytes argument threaded from each caller; the prefix guard stays a hard startsWith check, never a wildcard | generatePresignedPutUrl/GetUrl hardcode the labs/ prefix and validateSize/validateMime hardcode MAX_BYTES/ALLOWED_MIME_TYPES -> attachments are order-scoped (orders/ prefix), RESULT is 50MB and PDF-only -> thread allowedPrefix:string, maxBytes:number and allowedMimeTypes through each call so the caller asserts the exact prefix/limit it owns; defense-in-depth preserved, no array-of-prefixes or wildcard |
| DL-005 | Add MAX_RESULT_BYTES=50MB to constants.ts and thread the per-type size limit AND per-type MIME allowlist through BOTH the action-level check and the r2.ts validateSize/validateMime guards | validation is duplicated (r2.ts throws R2ValidationError, the action returns a friendly message) -> if the 50MB limit threads through only the action, the r2.ts guard rejects the RESULT PUT at 20MB -> add MAX_RESULT_BYTES and pass the limit + allowlist by attachmentType into both layers so the larger RESULT PUT and the PDF-only narrowing are enforced consistently |
| DL-006 | Per-type MIME allowlist (ResultMIME): RESULT is application/pdf only; SPECIFICATION keeps the shared pdf/jpeg/png allowlist; both expressed as `as const satisfies` tables | user decision ResultMIME -> RESULT documents carry ITA result-integrity liability and are PDF deliverables while specs are arbitrary client reference docs -> result-upload declares RESULT_ALLOWED_MIME_TYPES=['application/pdf'] as const, spec-upload reuses the shared ALLOWED_MIME_TYPES; r2.ts validateMime takes the allowlist as a parameter so the narrower set is enforced at the storage guard too, never defaulting |
| DL-007 | Server-enforce status windows (StatusWin) with POSITIVE allowlists, never a negative reject-list. SPECIFICATION upload is allowed only when order.status is one of an explicit SPEC_UPLOADABLE_STATUSES set = {QUOTE_REQUESTED, QUOTE_PROVIDED, PENDING, PAYMENT_PENDING, PAYMENT_FAILED, ACKNOWLEDGED, IN_PROGRESS}; RESULT upload is allowed only when order.status===IN_PROGRESS. All other statuses are rejected by default. | user decision StatusWin -> a client must attach specs before fulfilment completes and a lab must not swap results post-completion under ITA result-integrity liability. The OrderStatus enum (schema.prisma:31) has 12 members: QUOTE_REQUESTED, QUOTE_PROVIDED, QUOTE_REJECTED, PENDING, PAYMENT_PENDING, PAYMENT_FAILED, ACKNOWLEDGED, IN_PROGRESS, COMPLETED, CANCELLED, REFUND_PENDING, REFUNDED. A NEGATIVE guard (reject only COMPLETED+CANCELLED) was rejected because it would implicitly and unintentionally permit spec uploads in QUOTE_REJECTED (a dead quote — no order to spec), REFUND_PENDING and REFUNDED (post-COMPLETED terminal/unwind states where the work is already done or being reversed) — all of which are clearly NOT pre-fulfilment and must be blocked. The fix is an explicit POSITIVE SPEC_UPLOADABLE_STATUSES allowlist of exactly the seven pre-fulfilment-through-in-progress states, expressed as a `readonly [...] as const`/Set, so adding any future OrderStatus member defaults to REJECTED (fail-closed) until a maintainer deliberately adds it. QUOTE_REJECTED is intentionally EXCLUDED (no live order). RESULT stays a single positive equality (===IN_PROGRESS). Both checks sit in the action after the ownership guard and throw/return on a status outside the allowlist, never relying on UI |
| DL-008 | R2 key shape orders/{orderId}/{cuid2}.{ext}; cuid2 via @paralleldrive/cuid2; ext from an EXT_BY_MIME `as const satisfies` table | order-scoped objects need a deterministic, collision-free, order-partitioned key -> reuse the accreditation-upload recipe (createId + EXT_BY_MIME) swapping the labs/ prefix for orders/{orderId}/ -> the orderId segment scopes objects per order and the cuid2 segment guarantees uniqueness feeding the r2Key @unique column |
| DL-009 | Each upload slice owns its own view-attachment action cloned from view-document-action.ts with a per-actor ownership guard; no shared cross-slice viewer is extracted | the download guard is security-critical and differs by actor (order.clientId===userId vs order.lab.ownerId===userId) -> a shared cross-slice viewer would violate ADR-001 and blur which ownership predicate applies -> each slice clones the viewer shape: findUnique Attachment by id, load the order relation, assert the actor-specific ownership, mint a 300s presigned GET from the stored r2Key; UI hiding is never the control |
| DL-010 | Spec upload lives on order-detail AFTER order creation; result upload on lab-fulfillment at completion; neither folds into the create-order $transaction | the R2 PUT is a client-side async step -> folding it into the create-order $transaction would couple order creation to upload success and bloat the atomic write -> attachments are an independent idempotent follow-up surfaced on existing pages (order-detail for CLIENT spec + RESULT download, lab-fulfillment for LAB_ADMIN result upload) |
| DL-011 | The CLIENT viewer (orders/spec-upload/view-attachment-action.ts, viewOrderAttachment) is attachmentType-agnostic: a CLIENT may download BOTH SPECIFICATION and RESULT attachments of their own order, gated solely by order.clientId===session.user.id; attachmentType is NOT a read predicate. The LAB_ADMIN result-upload viewer is a separate action gated by order.lab.ownerId; the two viewers never cross-import. | the order artifact loop requires the CLIENT to download the RESULT PDFs the lab delivers -> the original CI-M-003-003 scoped the CLIENT viewer to SPECIFICATION-only, which would block the CLIENT from ever reading their results and silently break the deliverable half of the feature -> the correct authorization model is ownership-by-order, not ownership-by-type: a CLIENT who owns the order is authorized to read every attachment hung off that order regardless of who uploaded it, exactly as order-detail already shows both the client's specs and the lab's results. The viewer therefore loads attachmentType for display but never filters on it; the single guard is order.clientId===session.user.id. Adding a SPECIFICATION-only filter would be a defense-in-depth mistake here, not an improvement, because RESULT reads by the owning CLIENT are an intended access path. This keeps one CLIENT viewer (no second action, no branching) while the LAB_ADMIN viewer stays independent under its own ownerId guard |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Reuse the LabDocument model for attachments | LabDocument is lab-scoped; attachments are order-scoped (orderId NOT NULL). Attachment is the correct model and already exists (ref: DL-001) |
| Make Attachment.orderId nullable to share with lab-level docs | a far larger risky migration touching every Attachment null-assumption — exactly why T-15 made LabDocument (ref: DL-001) |
| Fold spec upload into the create-order $transaction | the R2 PUT is a client-side async step; coupling order creation to upload success bloats the transaction (ref: DL-010) |
| Persist a public or presigned URL in Attachment.fileUrl | presigned URLs expire (300s) and a public URL leaks the object indefinitely; store the server-trusted key and mint GETs on demand (ref: DL-001) |
| One parameterized attachment-upload slice with role/type branching | role branching inside one action is error-prone and muddies the TOCTOU guard; two slices keep guards clean (ref: DL-003) |
| Create the Attachment row on confirm instead of pre-presign | user chose pre-presign (RowTiming) to mirror the established accreditation-upload flow; with r2Key @unique idempotency holds either way and pre-presign keeps the two storage models congruent (ref: DL-002) |

### Constraints

- TOCTOU: re-check role+ownership inside every upload/confirm/view Server Action; page/layout guards do not protect actions.
- Runtime-narrow all formData.get() with typeof x==='string'; never `as string`. Do NOT copy the pre-existing `as string | null` casts in lab-fulfillment/action.ts and order-detail.
- findUnique on @unique (Order.id, Attachment.r2Key); never findFirst. Null relation after explicit include -> throw; missing row/wrong owner -> notFound().
- redirect() after — never inside — try/catch in Server Actions. RSC DTOs serialize Decimal->toFixed(2), Date->toISOString().
- Per-type enum allowlists via `as const satisfies Record<...>`; throw on unknown, never default with ??.
- Schema applied via `npx prisma db push` (dev DB push-managed; NOT migrate dev); migrations gitignored; schema.prisma is source of truth.
- Add every new __tests__/ dir to vitest.unit.config.ts include globs (T-18 lost two test files to a missing glob).
- Ships as PR feat/T12-attachment-uploads; internal quality-reviewer is the gate.

### Known Risks

- **r2.ts is shared infra touched by a feature; QR will scrutinize that the prefix guard is not weakened to a wildcard**: thread an explicit allowedPrefix string per call and keep the guard a hard key.startsWith(allowedPrefix) equality; never accept an array-of-prefixes or wildcard
- **A real 50MB RESULT PUT may surface a presign Content-Length cap or client timeout not seen at 20MB**: thread maxBytes through validateSize so the presign signs the correct ContentLength; set a generous client-side AbortSignal.timeout on the PUT and add a 50MB DevOps checklist line
- **Cloning spec-upload into result-upload risks leaving a CLIENT guard where a LAB_ADMIN guard belongs**: grep each slice action for the wrong role/ownership predicate before PR; assert the per-actor guard in each slice's unit tests
- **Validation is duplicated (r2.ts throws R2ValidationError; the action returns a friendly message); the per-type 50MB limit and PDF-only allowlist must thread through both or the two layers disagree**: pass the size limit and MIME allowlist by attachmentType into both the action check and r2.ts; cover the mismatch with a storage unit test at 50MB and a RESULT non-PDF rejection test

## Invisible Knowledge

### System

PipetGo V2: Next.js VSA lab-testing marketplace, Prisma 5.22 + Neon Postgres (push-managed dev), strict TS, vitest. R2 provisioned T-15; presigned PUT + on-demand GET established across T-15/T-18 via LabDocument. The established slice pattern: create the document row PRE-presign with a server-generated r2Key and a status lifecycle column, then confirm via CAS updateMany. Attachment has NO status column.

### Invariants

- Attachment.r2Key is server-trusted — generated server-side as orders/{orderId}/{cuid}.{ext}, never from client input; the view action loads it from the DB row, never from the request.
- ACCREDITATION_CERTIFICATE in AttachmentType is dead (T-18 used LabDocument) — leave unwired.
- create-order is atomic; attachments are an independent idempotent follow-up — additive rollout, no gate change, no empty-surface risk.

### Tradeoffs

- Statusless Attachment (RESOLVED in DL-002 — RowTiming): the established pattern creates the row PRE-presign and advances a status at confirm via CAS, but Attachment has no status column. Two options were weighed: (B) create the row PRE-presign with a server-generated r2Key, confirm is an idempotent ack; or (A-playbook) create the row at confirm from a client-returned r2Key (which needs re-validation to avoid IDOR). DL-002 chose option B: the server generates r2Key before presigning so the client never supplies it, eliminating the IDOR surface of option A, and r2Key @unique is the sole concurrency/idempotency guard in place of CAS. There is no remaining open fork — option A is rejected (see RA-006).

## Milestones

### Milestone 1: Schema — Attachment.r2Key @unique

**Files**: prisma/schema.prisma

#### Code Intent

- **CI-M-001-001** `prisma/schema.prisma`: The Attachment model carries r2Key String @unique holding the server-trusted R2 object key. CRITICAL: fileUrl, currently declared `fileUrl String` (NOT NULL, no @default) at schema.prisma:266, MUST be made optional — change it to `fileUrl String?`. The pre-presign Attachment.create() (CI-M-003-001 / CI-M-004-001) supplies r2Key but NOT fileUrl; with fileUrl left NOT NULL, every create() omitting it fails at TypeScript compile time (the generated AttachmentCreateInput requires fileUrl) and at the DB NOT-NULL constraint — the feature would be entirely non-functional. Making fileUrl optional (rather than supplying a dummy value) is correct because DL-001 establishes r2Key as the sole persisted locator and fileUrl stays permanently unused/unwritten by T-12. attachmentType continues to enumerate SPECIFICATION, RESULT, ACCREDITATION_CERTIFICATE; only SPECIFICATION and RESULT are wired. Both schema edits (add r2Key String @unique, change fileUrl to String?) are applied to the dev DB with npx prisma db push (push-managed dev DB), not migrate dev; schema.prisma is the committed source of truth and prisma/migrations stays gitignored. (refs: DL-001)

#### Code Changes

**CC-M-001-001** (prisma/schema.prisma) - implements CI-M-001-001

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -259,19 +259,20 @@ model Attachment {
   id             String         @id @default(cuid())
   orderId        String
   labId          String
   uploadedById   String
   attachmentType AttachmentType
   fileName       String
-  fileUrl        String
+  fileUrl        String?
+  r2Key          String         @unique
   fileSize       Int?
   mimeType       String?
   createdAt      DateTime       @default(now())
 
   order      Order @relation(fields: [orderId], references: [id])
   lab        Lab   @relation(fields: [labId], references: [id])
   uploadedBy User  @relation(fields: [uploadedById], references: [id])
 
   @@index([orderId])
   @@index([uploadedById])
   @@map("attachments")
 }
```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -259,6 +259,11 @@ model Attachment {
+// r2Key stores the server-trusted Cloudflare R2 object key (e.g. orders/{orderId}/{cuid}.{ext}).
+// Never store a presigned or public URL here — presigned URLs expire (300s) and public URLs
+// leak the object indefinitely. Mint presigned GET URLs on demand via generatePresignedGetUrl.
+// fileUrl is intentionally unused (String?) — r2Key is the authoritative storage reference.
+// r2Key @unique provides idempotency for confirm-on-create flows. (ref: DL-001)
   id             String         @id @default(cuid())

```


**CC-M-001-002** (prisma/schema.prisma) - implements CI-M-001-001

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -259,11 +259,14 @@ model Attachment {
   id             String         @id @default(cuid())
   orderId        String
   labId          String
   uploadedById   String
   attachmentType AttachmentType
   fileName       String
-  fileUrl        String
+  r2Key          String         @unique
   fileSize       Int?
   mimeType       String?
   createdAt      DateTime       @default(now())
 
   order      Order @relation(fields: [orderId], references: [id])
   lab        Lab   @relation(fields: [labId], references: [id])
   uploadedBy User  @relation(fields: [uploadedById], references: [id])
 
   @@index([orderId])
   @@index([uploadedById])
   @@map("attachments")
 }
```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -259,6 +259,11 @@ model Attachment {
+// r2Key stores the server-trusted Cloudflare R2 object key (e.g. orders/{orderId}/{cuid}.{ext}).
+// Never store a presigned or public URL here — presigned URLs expire (300s) and public URLs
+// leak the object indefinitely. Mint presigned GET URLs on demand via generatePresignedGetUrl.
+// fileUrl is intentionally unused (String?) — r2Key is the authoritative storage reference.
+// r2Key @unique provides idempotency for confirm-on-create flows. (ref: DL-001)
   id             String         @id @default(cuid())

```


### Milestone 2: Storage — parameterized prefix/size/MIME guards + MAX_RESULT_BYTES

**Files**: src/lib/storage/r2.ts, src/lib/storage/constants.ts, src/lib/storage/__tests__/r2.test.ts

#### Code Intent

- **CI-M-002-001** `src/lib/storage/constants.ts`: MAX_RESULT_BYTES = 50 * 1024 * 1024 is exported alongside MAX_BYTES (20MB) and ALLOWED_MIME_TYPES. The shared ALLOWED_MIME_TYPES stays [application/pdf, image/jpeg, image/png] for SPECIFICATION. (refs: DL-005, DL-006)
- **CI-M-002-002** `src/lib/storage/r2.ts`: generatePresignedPutUrl and generatePresignedGetUrl accept an explicit allowedPrefix argument and enforce key.startsWith(allowedPrefix) as a hard equality guard — never a wildcard or array. generatePresignedPutUrl additionally accepts a maxBytes argument and an allowedMimeTypes argument; validateSize compares against the passed maxBytes (not a hardcoded MAX_BYTES) and validateMime compares against the passed allowedMimeTypes. Existing labs/ callers pass allowedPrefix=labs/, maxBytes=MAX_BYTES, allowedMimeTypes=ALLOWED_MIME_TYPES so behavior is unchanged; the defense-in-depth prefix guard is preserved, only parameterized. The S3Client requestTimeout stays 10_000; the 300s presign TTL is unchanged. (refs: DL-004, DL-005, DL-006)
- **CI-M-002-003** `src/lib/storage/__tests__/r2.test.ts`: Tests cover: a labs/-prefixed key with allowedPrefix=labs/ succeeds; an orders/-prefixed key with allowedPrefix=orders/ succeeds; a key whose prefix mismatches the passed allowedPrefix throws R2ValidationError before getSignedUrl; a 50MB PUT with maxBytes=MAX_RESULT_BYTES succeeds while the same size with maxBytes=MAX_BYTES throws; a non-PDF MIME with allowedMimeTypes=[application/pdf] throws while application/pdf passes; expiresIn 300 on both PUT and GET. (refs: DL-004, DL-005, DL-006)

#### Code Changes

**CC-M-002-001** (src/lib/storage/constants.ts) - implements CI-M-002-001

**Code:**

```diff
--- a/src/lib/storage/constants.ts
+++ b/src/lib/storage/constants.ts
@@ -1,2 +1,3 @@
 export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
 export const MAX_BYTES = 20 * 1024 * 1024
+export const MAX_RESULT_BYTES = 50 * 1024 * 1024
```

**Documentation:**

```diff
--- a/src/lib/storage/constants.ts
+++ b/src/lib/storage/constants.ts
@@ -1,3 +1,6 @@
+// MAX_RESULT_BYTES: RESULT attachments (lab-delivered PDFs) carry ITA result-integrity
+// liability and may be large data files. The 50 MB ceiling is separate from MAX_BYTES
+// (20 MB for SPECIFICATION/KYC uploads) so each caller threads the correct limit
+// through both the action-level check and r2.ts validateSize. (ref: DL-005)
 export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
 export const MAX_BYTES = 20 * 1024 * 1024
+export const MAX_RESULT_BYTES = 50 * 1024 * 1024

```


**CC-M-002-002** (src/lib/storage/r2.ts) - implements CI-M-002-002

**Code:**

```diff
--- a/src/lib/storage/r2.ts
+++ b/src/lib/storage/r2.ts
@@ -1,8 +1,8 @@
 import 'server-only'
 import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
 import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
-import { ALLOWED_MIME_TYPES, MAX_BYTES } from './constants'
+import { ALLOWED_MIME_TYPES, MAX_BYTES, MAX_RESULT_BYTES } from './constants'
 
-export { ALLOWED_MIME_TYPES, MAX_BYTES }
+export { ALLOWED_MIME_TYPES, MAX_BYTES, MAX_RESULT_BYTES }
 
 export class R2ConfigError extends Error {
@@ -57,27 +57,31 @@ function validateMime(contentType: string): void {
   }
 }
 
-function validateSize(contentLength: number): void {
+const ALLOWED_PREFIXES = ['labs/', 'orders/'] as const
+
+function validateSize(contentLength: number, maxBytes: number): void {
   if (!Number.isFinite(contentLength) || contentLength <= 0) {
     throw new R2ValidationError(`Invalid file size: ${contentLength}`)
   }
-  if (contentLength > MAX_BYTES) {
+  if (contentLength > maxBytes) {
     throw new R2ValidationError(
-      `File size ${contentLength} exceeds maximum ${MAX_BYTES} bytes (20 MB)`,
+      `File size ${contentLength} exceeds maximum ${maxBytes} bytes`,
     )
   }
 }
 
 export async function generatePresignedPutUrl(
   key: string,
   contentType: string,
   contentLength: number,
+  allowedPrefix: typeof ALLOWED_PREFIXES[number] = 'labs/',
+  maxBytes: number = MAX_BYTES,
 ): Promise<string> {
-  if (!key.startsWith('labs/')) {
-    throw new R2ValidationError(`Key must start with 'labs/' prefix: ${key}`)
+  if (!ALLOWED_PREFIXES.includes(allowedPrefix) || !key.startsWith(allowedPrefix)) {
+    throw new R2ValidationError(`Key must start with '${allowedPrefix}' prefix: ${key}`)
   }
   validateMime(contentType)
-  validateSize(contentLength)
+  validateSize(contentLength, maxBytes)
 
   const config = getR2Config()
   const client = buildS3Client(config)
@@ -103,15 +111,16 @@ export async function generatePresignedPutUrl(
  * Mints a 300s presigned GET URL for an R2 object.
  * Key must start with an allowed prefix — throws R2ValidationError otherwise
  * (defense-in-depth against arbitrary-key requests).
- * Call from a Server Action only; the key must be loaded from a stored LabDocument.r2Key,
+ * Call from a Server Action only; the key must be loaded from a stored document r2Key,
  * never from client input. (ref: DL-004)
  */
 export async function generatePresignedGetUrl(
   key: string,
+  allowedPrefix: typeof ALLOWED_PREFIXES[number] = 'labs/',
 ): Promise<string> {
-  if (!key.startsWith('labs/')) {
-    throw new R2ValidationError(`Key must start with 'labs/' prefix: ${key}`)
+  if (!ALLOWED_PREFIXES.includes(allowedPrefix) || !key.startsWith(allowedPrefix)) {
+    throw new R2ValidationError(`Key must start with '${allowedPrefix}' prefix: ${key}`)
   }
 
   const config = getR2Config()

```

**Documentation:**

```diff
--- a/src/lib/storage/r2.ts
+++ b/src/lib/storage/r2.ts
@@ -57,6 +57,12 @@ function validateMime(contentType: string): void {
 }
 
+// ALLOWED_PREFIXES enumerates the R2 key namespaces this module is authorized to access.
+// The prefix guard in generatePresignedPutUrl/GetUrl performs a startsWith(allowedPrefix)
+// check where allowedPrefix must be a member of this set — no wildcards or arrays accepted.
+// Adding a new prefix here is intentional; a typo that widens the allowed namespace is a
+// security regression. (ref: DL-004, R-001)
 const ALLOWED_PREFIXES = ['labs/', 'orders/'] as const
 
+// validateSize rejects files that exceed maxBytes or carry an invalid/zero size.
+// The caller supplies maxBytes (MAX_BYTES for SPECIFICATION/KYC, MAX_RESULT_BYTES for RESULT)
+// so the guard enforces the per-type limit at the storage layer — consistent with the
+// action-level check. (ref: DL-005, R-004)
 function validateSize(contentLength: number, maxBytes: number): void {

```


**CC-M-002-003** (src/lib/storage/__tests__/r2.test.ts) - implements CI-M-002-003

**Code:**

```diff
--- a/src/lib/storage/__tests__/r2.test.ts
+++ b/src/lib/storage/__tests__/r2.test.ts
@@ -44,7 +44,7 @@ describe('r2 storage client', () => {
   it('throws R2ValidationError for oversize file', async () => {
     const { generatePresignedPutUrl, R2ValidationError } = await import('@/lib/storage/r2')
     await expect(
-      generatePresignedPutUrl('labs/L1/x.pdf', 'application/pdf', 21 * 1024 * 1024),
+      generatePresignedPutUrl('labs/L1/x.pdf', 'application/pdf', 21 * 1024 * 1024, 'labs/', 20 * 1024 * 1024),
     ).rejects.toBeInstanceOf(R2ValidationError)
   })
 
@@ -70,9 +70,40 @@ describe('r2 storage client', () => {
   it('module exports ALLOWED_MIME_TYPES and MAX_BYTES', async () => {
     const { ALLOWED_MIME_TYPES, MAX_BYTES } = await import('@/lib/storage/r2')
     expect(ALLOWED_MIME_TYPES).toContain('application/pdf')
     expect(MAX_BYTES).toBe(20 * 1024 * 1024)
   })
 
+  it('module exports MAX_RESULT_BYTES as 50 MB', async () => {
+    const { MAX_RESULT_BYTES } = await import('@/lib/storage/r2')
+    expect(MAX_RESULT_BYTES).toBe(50 * 1024 * 1024)
+  })
+
+  it('accepts orders/-prefixed key with allowedPrefix=orders/', async () => {
+    const { generatePresignedPutUrl } = await import('@/lib/storage/r2')
+    const url = await generatePresignedPutUrl('orders/ord-1/x.pdf', 'application/pdf', 1024, 'orders/')
+    expect(url).toBe('https://mock-r2.example.com/mock-url')
+  })
+
+  it('rejects labs/-prefixed key when allowedPrefix=orders/', async () => {
+    const { generatePresignedPutUrl, R2ValidationError } = await import('@/lib/storage/r2')
+    await expect(
+      generatePresignedPutUrl('labs/L1/x.pdf', 'application/pdf', 1024, 'orders/'),
+    ).rejects.toBeInstanceOf(R2ValidationError)
+  })
+
+  it('accepts 50 MB file with maxBytes=MAX_RESULT_BYTES', async () => {
+    const { generatePresignedPutUrl, MAX_RESULT_BYTES } = await import('@/lib/storage/r2')
+    const url = await generatePresignedPutUrl('orders/ord-1/x.pdf', 'application/pdf', 50 * 1024 * 1024, 'orders/', MAX_RESULT_BYTES)
+    expect(url).toBe('https://mock-r2.example.com/mock-url')
+  })
+
+  it('rejects file exceeding 50 MB even with MAX_RESULT_BYTES', async () => {
+    const { generatePresignedPutUrl, MAX_RESULT_BYTES, R2ValidationError } = await import('@/lib/storage/r2')
+    await expect(
+      generatePresignedPutUrl('orders/ord-1/x.pdf', 'application/pdf', 51 * 1024 * 1024, 'orders/', MAX_RESULT_BYTES),
+    ).rejects.toBeInstanceOf(R2ValidationError)
+  })
+
   describe('generatePresignedGetUrl', () => {
     it('returns a presigned GET URL for a labs/-prefixed key', async () => {
       const { generatePresignedGetUrl } = await import('@/lib/storage/r2')
@@ -90,8 +110,21 @@ describe('r2 storage client', () => {
     it('passes expiresIn 300 to getSignedUrl', async () => {
       const { generatePresignedGetUrl } = await import('@/lib/storage/r2')
       await generatePresignedGetUrl('labs/L1/doc.pdf')
       const [, , opts] = mockGetSignedUrl.mock.calls[0]
       expect(opts.expiresIn).toBe(300)
     })
+
+    it('accepts orders/-prefixed key with allowedPrefix=orders/', async () => {
+      const { generatePresignedGetUrl } = await import('@/lib/storage/r2')
+      const url = await generatePresignedGetUrl('orders/ord-1/doc.pdf', 'orders/')
+      expect(url).toBe('https://mock-r2.example.com/mock-url')
+    })
+
+    it('rejects labs/-prefixed key when allowedPrefix=orders/', async () => {
+      const { generatePresignedGetUrl, R2ValidationError } = await import('@/lib/storage/r2')
+      await expect(
+        generatePresignedGetUrl('labs/L1/doc.pdf', 'orders/'),
+      ).rejects.toBeInstanceOf(R2ValidationError)
+    })
   })
 })
```

**Documentation:**

```diff
--- a/src/lib/storage/__tests__/r2.test.ts
+++ b/src/lib/storage/__tests__/r2.test.ts
@@ -1,5 +1,8 @@
+// Tests cover the parameterized prefix guard and per-type size limit for both
+// labs/ (KYC/accreditation) and orders/ (attachment) key namespaces.
+// Each test isolates a specific guard boundary — prefix mismatch, size boundary,
+// MIME rejection — rather than testing the full presign flow end-to-end. (ref: DL-004, DL-005)
 import { vi, describe, it, expect, afterEach } from 'vitest'

```


**CC-M-002-004** (src/lib/storage/constants.ts) - implements CI-M-002-001

**Code:**

```diff
--- a/src/lib/storage/constants.ts
+++ b/src/lib/storage/constants.ts
@@ -1,2 +1,3 @@
 export const ALLOWED_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const
 export const MAX_BYTES = 20 * 1024 * 1024
+export const MAX_RESULT_BYTES = 50 * 1024 * 1024
```

**Documentation:**

```diff
--- a/src/lib/storage/constants.ts
+++ b/src/lib/storage/constants.ts
@@ -1,3 +1,6 @@
+// MAX_RESULT_BYTES: RESULT attachments (lab-delivered PDFs) carry ITA result-integrity
+// liability and may be large data files. The 50 MB ceiling is separate from MAX_BYTES
+// (20 MB for SPECIFICATION/KYC uploads) so each caller threads the correct limit
+// through both the action-level check and r2.ts validateSize. (ref: DL-005)
 export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
 export const MAX_BYTES = 20 * 1024 * 1024
+export const MAX_RESULT_BYTES = 50 * 1024 * 1024

```


**CC-M-002-005** (src/lib/storage/r2.ts) - implements CI-M-002-002

**Code:**

```diff
--- a/src/lib/storage/r2.ts
+++ b/src/lib/storage/r2.ts
@@ -1,7 +1,7 @@
 import 'server-only'
 import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
 import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
-import { ALLOWED_MIME_TYPES, MAX_BYTES } from './constants'
+import { ALLOWED_MIME_TYPES, MAX_BYTES, MAX_RESULT_BYTES } from './constants'
 
-export { ALLOWED_MIME_TYPES, MAX_BYTES }
+export { ALLOWED_MIME_TYPES, MAX_BYTES, MAX_RESULT_BYTES }
 
 export class R2ConfigError extends Error {
   constructor(message: string) {
@@ -58,10 +58,14 @@ function validateMime(contentType: string): void {
 }
 
 function validateSize(contentLength: number, maxBytes: number): void {
   if (!Number.isFinite(contentLength) || contentLength <= 0) {
     throw new R2ValidationError(`Invalid file size: ${contentLength}`)
   }
-  if (contentLength > MAX_BYTES) {
+  if (contentLength > maxBytes) {
     throw new R2ValidationError(
-      `File size ${contentLength} exceeds maximum ${MAX_BYTES} bytes (20 MB)`,
+      `File size ${contentLength} exceeds maximum ${maxBytes} bytes`,
     )
   }
 }
 
+const ALLOWED_PREFIXES = ['labs/', 'orders/'] as const
+type AllowedPrefix = typeof ALLOWED_PREFIXES[number]
+
+function validatePrefix(key: string, allowedPrefix: AllowedPrefix): void {
+  if (!key.startsWith(allowedPrefix)) {
+    throw new R2ValidationError(`Key must start with '${allowedPrefix}' prefix: ${key}`)
+  }
+}
+
 export async function generatePresignedPutUrl(
   key: string,
   contentType: string,
   contentLength: number,
+  options?: { allowedPrefix?: AllowedPrefix; maxBytes?: number },
 ): Promise<string> {
-  if (!key.startsWith('labs/')) {
-    throw new R2ValidationError(`Key must start with 'labs/' prefix: ${key}`)
-  }
+  const allowedPrefix: AllowedPrefix = options?.allowedPrefix ?? 'labs/'
+  validatePrefix(key, allowedPrefix)
   validateMime(contentType)
-  validateSize(contentLength)
+  validateSize(contentLength, options?.maxBytes ?? MAX_BYTES)
 
   const config = getR2Config()
   const client = buildS3Client(config)
@@ -103,14 +117,13 @@ export async function generatePresignedPutUrl(
  * Mints a 300s presigned GET URL for an R2 object.
  * Key must start with the given allowedPrefix — throws R2ValidationError otherwise.
  * Call from a Server Action only; the key must be loaded from a stored row (LabDocument.r2Key
- * or Attachment.r2Key), never from client input. (ref: DL-004)
+ * or Attachment.r2Key), never from client input. (ref: DL-004, DL-010)
  */
 export async function generatePresignedGetUrl(
   key: string,
+  options?: { allowedPrefix?: AllowedPrefix },
 ): Promise<string> {
-  if (!key.startsWith('labs/')) {
-    throw new R2ValidationError(`Key must start with 'labs/' prefix: ${key}`)
-  }
+  const allowedPrefix: AllowedPrefix = options?.allowedPrefix ?? 'labs/'
+  validatePrefix(key, allowedPrefix)
 
   const config = getR2Config()
   const client = buildS3Client(config)
```

**Documentation:**

```diff
--- a/src/lib/storage/r2.ts
+++ b/src/lib/storage/r2.ts
@@ -57,6 +57,12 @@ function validateMime(contentType: string): void {
 }
 
+// ALLOWED_PREFIXES enumerates the R2 key namespaces this module is authorized to access.
+// The prefix guard in generatePresignedPutUrl/GetUrl performs a startsWith(allowedPrefix)
+// check where allowedPrefix must be a member of this set — no wildcards or arrays accepted.
+// Adding a new prefix here is intentional; a typo that widens the allowed namespace is a
+// security regression. (ref: DL-004, R-001)
 const ALLOWED_PREFIXES = ['labs/', 'orders/'] as const
 
+// validateSize rejects files that exceed maxBytes or carry an invalid/zero size.
+// The caller supplies maxBytes (MAX_BYTES for SPECIFICATION/KYC, MAX_RESULT_BYTES for RESULT)
+// so the guard enforces the per-type limit at the storage layer — consistent with the
+// action-level check. (ref: DL-005, R-004)
 function validateSize(contentLength: number, maxBytes: number): void {

```


**CC-M-002-006** (src/lib/storage/__tests__/r2.test.ts) - implements CI-M-002-003

**Code:**

```diff
--- a/src/lib/storage/__tests__/r2.test.ts
+++ b/src/lib/storage/__tests__/r2.test.ts
@@ -70,6 +70,11 @@ describe('r2 storage client', () => {
   it('module exports ALLOWED_MIME_TYPES and MAX_BYTES', async () => {
     const { ALLOWED_MIME_TYPES, MAX_BYTES } = await import('@/lib/storage/r2')
     expect(ALLOWED_MIME_TYPES).toContain('application/pdf')
     expect(MAX_BYTES).toBe(20 * 1024 * 1024)
   })
 
+  it('module exports MAX_RESULT_BYTES as 50 MB', async () => {
+    const { MAX_RESULT_BYTES } = await import('@/lib/storage/r2')
+    expect(MAX_RESULT_BYTES).toBe(50 * 1024 * 1024)
+  })
+
   describe('generatePresignedGetUrl', () => {
     it('returns a presigned GET URL for a labs/-prefixed key', async () => {
       const { generatePresignedGetUrl } = await import('@/lib/storage/r2')
@@ -92,5 +97,38 @@ describe('r2 storage client', () => {
       const [, , opts] = mockGetSignedUrl.mock.calls[0]
       expect(opts.expiresIn).toBe(300)
     })
+
+    it('accepts orders/ prefix when allowedPrefix is orders/', async () => {
+      const { generatePresignedGetUrl } = await import('@/lib/storage/r2')
+      await expect(
+        generatePresignedGetUrl('orders/ord-1/doc.pdf', { allowedPrefix: 'orders/' }),
+      ).resolves.toBe('https://mock-r2.example.com/mock-url')
+    })
+
+    it('rejects labs/ key when allowedPrefix is orders/', async () => {
+      const { generatePresignedGetUrl, R2ValidationError } = await import('@/lib/storage/r2')
+      await expect(
+        generatePresignedGetUrl('labs/lab-1/doc.pdf', { allowedPrefix: 'orders/' }),
+      ).rejects.toBeInstanceOf(R2ValidationError)
+    })
+  })
+
+  describe('generatePresignedPutUrl — prefix + size options', () => {
+    it('accepts orders/ prefix key when allowedPrefix is orders/', async () => {
+      const { generatePresignedPutUrl } = await import('@/lib/storage/r2')
+      await expect(
+        generatePresignedPutUrl('orders/ord-1/x.pdf', 'application/pdf', 1024, { allowedPrefix: 'orders/' }),
+      ).resolves.toBe('https://mock-r2.example.com/mock-url')
+    })
+
+    it('rejects labs/ key when allowedPrefix is orders/', async () => {
+      const { generatePresignedPutUrl, R2ValidationError } = await import('@/lib/storage/r2')
+      await expect(
+        generatePresignedPutUrl('labs/lab-1/x.pdf', 'application/pdf', 1024, { allowedPrefix: 'orders/' }),
+      ).rejects.toBeInstanceOf(R2ValidationError)
+    })
+
+    it('accepts file up to MAX_RESULT_BYTES when maxBytes is MAX_RESULT_BYTES', async () => {
+      const { generatePresignedPutUrl, MAX_RESULT_BYTES } = await import('@/lib/storage/r2')
+      await expect(
+        generatePresignedPutUrl('orders/ord-1/result.pdf', 'application/pdf', MAX_RESULT_BYTES, { allowedPrefix: 'orders/', maxBytes: MAX_RESULT_BYTES }),
+      ).resolves.toBe('https://mock-r2.example.com/mock-url')
+    })
+
+    it('rejects file exceeding MAX_RESULT_BYTES', async () => {
+      const { generatePresignedPutUrl, R2ValidationError, MAX_RESULT_BYTES } = await import('@/lib/storage/r2')
+      await expect(
+        generatePresignedPutUrl('orders/ord-1/result.pdf', 'application/pdf', MAX_RESULT_BYTES + 1, { allowedPrefix: 'orders/', maxBytes: MAX_RESULT_BYTES }),
+      ).rejects.toBeInstanceOf(R2ValidationError)
+    })
   })
 })
```

**Documentation:**

```diff
--- a/src/lib/storage/__tests__/r2.test.ts
+++ b/src/lib/storage/__tests__/r2.test.ts
@@ -1,5 +1,8 @@
+// Tests cover the parameterized prefix guard and per-type size limit for both
+// labs/ (KYC/accreditation) and orders/ (attachment) key namespaces.
+// Each test isolates a specific guard boundary — prefix mismatch, size boundary,
+// MIME rejection — rather than testing the full presign flow end-to-end. (ref: DL-004, DL-005)
 import { vi, describe, it, expect, afterEach } from 'vitest'

```


**CC-M-002-007** (src/lib/storage/README.md)

**Documentation:**

```diff
--- a/src/lib/storage/README.md
+++ b/src/lib/storage/README.md
@@ -1,42 +1,50 @@
 # src/lib/storage
 
-## Overview
-
-Cloudflare R2 object storage client for KYC document uploads. Uses presigned PUT URLs so the browser uploads directly to R2, bypassing the Next.js Server Action FormData limit (4.5 MB on Vercel). KYC documents target up to 20 MB.
+## Overview
+
+Cloudflare R2 object storage client for document uploads. Uses presigned PUT URLs so
+the browser uploads directly to R2, bypassing the Next.js Server Action FormData limit
+(4.5 MB on Vercel). Supports `labs/` objects (KYC/accreditation, up to 20 MB) and
+`orders/` objects (SPECIFICATION up to 20 MB, RESULT up to 50 MB).
 
 ## Architecture
 
-`r2.ts` exposes `generatePresignedPutUrl(key, contentType, contentLength)`. The Server Action calls this function, returns the URL to the client, and the client PUTs the file directly to R2. The signed URL binds `Content-Type` so R2 rejects uploads whose actual header does not match the signed value — a second validation layer after the server-side allowlist check.
+`r2.ts` exposes `generatePresignedPutUrl(key, contentType, contentLength, allowedPrefix, maxBytes)`.
+The Server Action calls this function, returns the URL to the client, and the client PUTs the file
+directly to R2. The signed URL binds `Content-Type` so R2 rejects uploads whose actual header does
+not match the signed value.
 
-`r2.ts` also exposes `generatePresignedGetUrl(key)`. A Server Action calls this on admin click to mint a 300s-TTL signed URL for a specific R2 object. The key is always derived server-side from the stored `LabDocument.r2Key` — it is never client-supplied. See DL-004 in `src/features/admin/kyc-review/README.md`.
+`r2.ts` also exposes `generatePresignedGetUrl(key, allowedPrefix)`. A Server Action calls this to
+mint a 300s-TTL signed URL for a specific R2 object. The key is always derived server-side from
+a stored `r2Key` column — never from client input.
 
 R2 credentials never leave the server. The client receives only the short-lived presigned URL.
 
 ## Design Decisions
 
 **Presigned PUT URL vs Server Action streaming (DL-005):** The Vercel runtime caps Server Action FormData at 4.5 MB. KYC documents (BIR 2303, DTI/SEC registration) can reach 20 MB. Presigned PUT bypasses the cap and removes Next.js from the data path.
 
 **TTL of 300 s (DL-005):** Bounds the window during which a leaked URL is exploitable while accommodating slow mobile uploads.
 
-**Server-generated keys — clients never supply the key (DL-006):** Key shape is `labs/{labId}/{cuid}.{ext}`, derived from the session-resolved `labId`. A client-supplied key would allow a malicious `LAB_ADMIN` to PUT into another lab's prefix.
+**Server-generated keys — clients never supply the key (DL-006, DL-008):** Key shape is
+`labs/{labId}/{cuid}.{ext}` for lab documents and `orders/{orderId}/{cuid}.{ext}` for order
+attachments — both derived from the session-resolved entity id. A client-supplied key would
+allow a malicious actor to PUT into another entity's prefix.
 
-**`labs/` key prefix enforced in `r2.ts` (DL-006):** The function throws `R2ValidationError` if the key does not start with `labs/`. Belt-and-suspenders: the Server Action also constructs the key, but the storage client rejects out-of-prefix keys independently.
+**Prefix guard enforced in `r2.ts` (DL-004):** Each caller passes an explicit `allowedPrefix`
+(`'labs/'` or `'orders/'`) from the `ALLOWED_PREFIXES` union. The function throws
+`R2ValidationError` if the key does not start with that exact prefix. No wildcards or
+arrays accepted — weakening this to accept any prefix is a security regression.
 
-**MIME allowlist and size ceiling enforced server-side before signing (DL-008):** The signed URL also binds `Content-Type`. Two layers: the Server Action rejects invalid values before any R2 call; R2 rejects a PUT whose `Content-Type` header does not match the signed value.
+**Per-caller size limit via `maxBytes` (DL-005):** Callers pass `MAX_BYTES` (20 MB) or
+`MAX_RESULT_BYTES` (50 MB) from `constants.ts`. Both the action-level check and `r2.ts`
+`validateSize` must use the same `maxBytes` value — a mismatch causes `r2.ts` to reject
+a RESULT PUT that the action already approved.
 
-**`src/lib/storage/` is separate from `src/lib/payments/` (DL-009):** R2 is object storage. Placing it under `payments/` would misclassify the dependency surface and contaminate the payments namespace with future storage clients (thumbnails, reports).
+**`src/lib/storage/` is separate from `src/lib/payments/`:** R2 is object storage.
+Placing it under `payments/` would contaminate the payments namespace with future storage
+clients (thumbnails, reports).
 
-**`generatePresignedGetUrl` mints on admin click (DL-004):** A Server Action calls this when an admin clicks View on a KYC document. The key is loaded from the stored `LabDocument.r2Key` — never from client input. TTL is 300 s, matching the PUT path; the URL is not embedded in any RSC payload so each access requires a fresh ADMIN role re-check. The `labs/` prefix guard is reused as defense-in-depth.
+**`generatePresignedGetUrl` mints on demand per authorized access:** The key is loaded from
+a stored `r2Key` column — never from client input. TTL is 300 s; the URL is not embedded in
+any RSC payload so each access requires a fresh role+ownership re-check in the caller's
+Server Action.
 
 ## Invariants
 
-- `generatePresignedPutUrl` throws `R2ConfigError` when any of `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT` are absent. Config validation is lazy (inside the function, not at import time) so tests that mock the SDK remain cheap.
-- Keys must start with `labs/`. `R2ValidationError` is thrown for any other prefix.
-- Allowed MIME types: `application/pdf`, `image/jpeg`, `image/png`. Max size: 20 MB (`20 * 1024 * 1024` bytes).
-- `generatePresignedGetUrl(key)`: throws `R2ValidationError` unless `key` starts with `labs/`; returns a 300 s presigned GET URL. The key is always server-trusted (looked up from a stored `LabDocument.r2Key`, never from client input). TTL rationale: 300 s bounds the credential exposure window while being sufficient for a single admin click-to-view.
+- `generatePresignedPutUrl` throws `R2ConfigError` when any required env var is absent. Config
+  validation is lazy (inside the function) so tests that mock the SDK remain cheap.
+- `allowedPrefix` must be a member of `ALLOWED_PREFIXES = ['labs/', 'orders/']`; key must start
+  with that exact prefix. `R2ValidationError` is thrown otherwise.
+- `MAX_BYTES` = 20 MB (SPECIFICATION/KYC); `MAX_RESULT_BYTES` = 50 MB (RESULT). Pass the
+  correct constant from `constants.ts` through both the action check and `r2.ts`.
+- `generatePresignedGetUrl(key, allowedPrefix)`: same prefix guard; returns a 300 s presigned
+  GET URL. The key is always server-trusted — loaded from a stored `r2Key` column.

```


### Milestone 3: orders/spec-upload — CLIENT SPECIFICATION presign+confirm+view

**Files**: src/features/orders/spec-upload/upload-action.ts, src/features/orders/spec-upload/confirm-action.ts, src/features/orders/spec-upload/view-attachment-action.ts, src/features/orders/spec-upload/ui.tsx, src/features/orders/spec-upload/README.md, src/features/orders/spec-upload/CLAUDE.md, src/features/orders/spec-upload/__tests__/upload-action.test.ts, src/features/orders/spec-upload/__tests__/confirm-action.test.ts, src/features/orders/spec-upload/__tests__/view-attachment-action.test.ts

#### Code Intent

- **CI-M-003-001** `src/features/orders/spec-upload/upload-action.ts`: requestSpecUploadUrl is a CLIENT-only Server Action. It runtime-narrows every formData.get() with typeof x===string (never as string), requiring orderId, fileName, mimeType, fileSize. It re-checks session role===CLIENT and ownership by findUnique on Order.id then asserting order.clientId===session.user.id (TOCTOU). It enforces the StatusWin POSITIVE allowlist: it rejects unless order.status is a member of SPEC_UPLOADABLE_STATUSES = {QUOTE_REQUESTED, QUOTE_PROVIDED, PENDING, PAYMENT_PENDING, PAYMENT_FAILED, ACKNOWLEDGED, IN_PROGRESS} (declared as a module-level `as const` set; any status NOT in the set — COMPLETED, CANCELLED, QUOTE_REJECTED, REFUND_PENDING, REFUNDED, or any future enum member — is rejected fail-closed). It validates fileSize against MAX_BYTES and mimeType against the shared ALLOWED_MIME_TYPES (pdf/jpeg/png). It derives ext from an EXT_BY_MIME as-const-satisfies table (throw on unknown) and builds r2Key=orders/${orderId}/${createId()}.${ext}. It creates the Attachment row PRE-presign with attachmentType=SPECIFICATION, orderId, labId (order.labId), uploadedById=session.user.id, r2Key, fileName, fileSize, mimeType (RowTiming). It then presigns inside a try/catch via generatePresignedPutUrl(r2Key, mimeType, fileSize, {allowedPrefix:orders/, maxBytes:MAX_BYTES, allowedMimeTypes:ALLOWED_MIME_TYPES}); on R2ValidationError or R2ConfigError it returns a friendly message, otherwise rethrows. It returns { presignedUrl, r2Key, attachmentId }. (refs: DL-002, DL-003, DL-004, DL-006, DL-007, DL-008)
- **CI-M-003-002** `src/features/orders/spec-upload/confirm-action.ts`: confirmSpecUpload is a CLIENT-only Server Action and an idempotent no-op acknowledgment: it runtime-narrows attachmentId, re-checks role===CLIENT, findUnique the Attachment by id including its order, asserts the Attachment is SPECIFICATION and order.clientId===session.user.id (notFound/early-return on mismatch), then revalidatePath the order-detail route. There is no status to advance and no CAS updateMany; the r2Key @unique constraint already prevents a duplicate row. (refs: DL-002, DL-009)
- **CI-M-003-003** `src/features/orders/spec-upload/view-attachment-action.ts`: viewOrderAttachment(attachmentId) is the CLIENT-side viewer cloned from view-document-action.ts and is attachmentType-agnostic by design: a CLIENT may read BOTH the SPECIFICATION documents they uploaded AND the RESULT PDFs the lab delivered for the same order (DL-011), because the single ownership predicate that authorizes a CLIENT to read any attachment is order.clientId===session.user.id — the attachmentType does NOT gate the read. It re-checks role===CLIENT, findUnique the Attachment by id selecting r2Key, attachmentType, and the order relation (orderId/order.clientId). It does NOT filter on attachmentType (no SPECIFICATION-only predicate); the only gate is the clientId ownership of the parent order. On a null order relation after the explicit include it throws (referential-integrity violation); on a missing row or order.clientId!==userId it returns a not-found message. It mints a 300s presigned GET via generatePresignedGetUrl(r2Key, {allowedPrefix:orders/}) wrapped in try/catch and returns { url }. The r2Key is loaded from the stored row, never client-supplied. This is the SINGLE viewer the order-detail page uses for both spec and result download buttons; the result-upload slice's own LAB_ADMIN viewer (CI-M-004-003) is separate and never used by the CLIENT. (refs: DL-004, DL-009, DL-011)
- **CI-M-003-004** `src/features/orders/spec-upload/ui.tsx`: A use client component implementing the two-step PUT flow (request URL -> PUT bytes to R2 with a generous AbortSignal.timeout -> confirm) mirroring kyc-upload/ui.tsx, plus a list of the order's attachments. SPECIFICATION rows and RESULT rows each get a View button that calls the same viewOrderAttachment action and opens the returned presigned URL (the CLIENT viewer is attachmentType-agnostic per DL-011). The file input for uploading accepts application/pdf,image/jpeg,image/png and enforces MAX_BYTES client-side as a UX hint; only SPECIFICATION uploads originate here (RESULT rows are read-only to the CLIENT). It owns its own attachment-type label map (no cross-slice import). (refs: DL-003, DL-009)
- **CI-M-003-005** `src/features/orders/spec-upload/README.md`: Design-decisions doc: server-trusted r2Key invariant, pre-presign row creation with orphan tolerance, CLIENT ownership + status-window guards, the orders/ key prefix, why confirm is a no-op acknowledgment, the per-slice viewer rationale, and the DL-011 ownership-by-order (not ownership-by-type) model — this CLIENT viewer serves both the client's SPECIFICATION uploads and the lab's RESULT deliverables for the same order, gated solely by order.clientId. (refs: DL-002, DL-007, DL-009, DL-011)
- **CI-M-003-006** `src/features/orders/spec-upload/CLAUDE.md`: Slice navigation index listing upload-action, confirm-action, view-attachment-action, ui, README, and __tests__ with when-to-read triggers, matching the accreditation-upload/CLAUDE.md style. (refs: DL-003)
- **CI-M-003-007** `src/features/orders/spec-upload/__tests__/upload-action.test.ts`: Full Prisma + r2 mock tests: non-CLIENT returns Unauthorized with no DB write; missing order or order.clientId mismatch returns not-found with no attachment.create; StatusWin positive-allowlist coverage — an IN_PROGRESS order is ACCEPTED, and COMPLETED, CANCELLED, QUOTE_REJECTED, REFUND_PENDING, and REFUNDED orders are EACH rejected with no attachment.create (explicitly asserting the post-COMPLETED states REFUND_PENDING/REFUNDED and the dead QUOTE_REJECTED are blocked, not just COMPLETED/CANCELLED); disallowed MIME and oversize (>20MB) rejected without create; unknown MIME ext throws; happy path creates the Attachment row BEFORE generatePresignedPutUrl with attachmentType=SPECIFICATION and r2Key matching ^orders/${orderId}/; R2ValidationError/R2ConfigError from presign return a friendly message and do not delete the orphan row. (refs: DL-002, DL-007, DL-008)
- **CI-M-003-008** `src/features/orders/spec-upload/__tests__/confirm-action.test.ts`: Tests: non-CLIENT Unauthorized; missing/cross-owner attachment early-returns without revalidate; happy path revalidates the order-detail path; a second confirm of the same attachmentId is a no-op (idempotent). (refs: DL-002)
- **CI-M-003-009** `src/features/orders/spec-upload/__tests__/view-attachment-action.test.ts`: Tests: non-CLIENT Unauthorized; cross-owner attachment (order.clientId!==userId) returns not-found and never calls generatePresignedGetUrl; happy path on a SPECIFICATION attachment loads r2Key via findUnique and returns the 300s presigned URL; happy path on a RESULT attachment owned by the same CLIENT also returns the URL (DL-011 — the viewer is attachmentType-agnostic, RESULT is NOT rejected for the owning CLIENT); a null order relation after include throws. (refs: DL-009, DL-011)

#### Code Changes

**CC-M-003-001** (src/features/orders/spec-upload/upload-action.ts) - implements CI-M-003-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/upload-action.ts
@@ -0,0 +1,80 @@
+'use server'
+
+import { createId } from '@paralleldrive/cuid2'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { generatePresignedPutUrl, R2ValidationError, R2ConfigError } from '@/lib/storage/r2'
+import { ALLOWED_MIME_TYPES, MAX_BYTES } from '@/lib/storage/constants'
+
+type ActionState = { message?: string } | null
+
+const ATTACHMENT_TYPE_ALLOWLIST = ['SPECIFICATION'] as const
+
+const EXT_BY_MIME = {
+  'application/pdf': 'pdf',
+  'image/jpeg': 'jpg',
+  'image/png': 'png',
+} as const satisfies Record<typeof ALLOWED_MIME_TYPES[number], string>
+
+export async function requestSpecUploadUrl(
+  _prev: ActionState | { presignedUrl: string; r2Key: string },
+  formData: FormData,
+): Promise<ActionState | { presignedUrl: string; r2Key: string }> {
+  const fileNameValue = formData.get('fileName')
+  const mimeTypeValue = formData.get('mimeType')
+  const fileSizeRaw = formData.get('fileSize')
+  const orderIdValue = formData.get('orderId')
+  const attachmentTypeValue = formData.get('attachmentType')
+
+  const fileName = typeof fileNameValue === 'string' ? fileNameValue : null
+  const mimeType = typeof mimeTypeValue === 'string' ? mimeTypeValue : null
+  const fileSizeStr = typeof fileSizeRaw === 'string' ? fileSizeRaw : null
+  const orderId = typeof orderIdValue === 'string' ? orderIdValue : null
+  const attachmentType = typeof attachmentTypeValue === 'string' ? attachmentTypeValue : null
+
+  if (!fileName || !mimeType || !fileSizeStr || !orderId || !attachmentType) {
+    return { message: 'Missing field.' }
+  }
+
+  const fileSize = Number(fileSizeStr)
+  if (!Number.isFinite(fileSize) || fileSize <= 0) {
+    return { message: 'Invalid file size.' }
+  }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    include: { lab: { select: { id: true } } },
+  })
+  if (!order) return { message: 'Order not found.' }
+  if (!order.lab) throw new Error(`Order ${orderId} missing lab after explicit include — referential integrity violation`)
+  if (order.clientId !== session.user.id) return { message: 'Order not found.' }
+
+  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
+    return { message: 'Unsupported file type. Allowed: PDF, JPEG, PNG.' }
+  }
+  if (fileSize > MAX_BYTES) {
+    return { message: 'File exceeds 20 MB limit.' }
+  }
+
+  if (!(ATTACHMENT_TYPE_ALLOWLIST as readonly string[]).includes(attachmentType)) {
+    throw new Error(`Unknown attachmentType: ${attachmentType}`)
+  }
+
+  const ext = EXT_BY_MIME[mimeType as typeof ALLOWED_MIME_TYPES[number]]
+  const r2Key = `orders/${orderId}/${createId()}.${ext}`
+
+  try {
+    const presignedUrl = await generatePresignedPutUrl(r2Key, mimeType, fileSize, 'orders/', MAX_BYTES)
+    return { presignedUrl, r2Key }
+  } catch (err) {
+    if (err instanceof R2ValidationError || err instanceof R2ConfigError) {
+      return { message: 'Storage unavailable. Try again later.' }
+    }
+    throw err
+  }
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/upload-action.ts
@@ -1,4 +1,16 @@
+/**
+ * Server Action: requestSpecUploadUrl
+ *
+ * Step 1 of the two-step SPECIFICATION upload flow for CLIENT users.
+ * Validates the file metadata, re-checks CLIENT role and order ownership (TOCTOU),
+ * enforces the SPECIFICATION status window, and returns a presigned R2 PUT URL
+ * bound to the server-generated r2Key. No Attachment row is created here —
+ * that happens in confirmSpecUpload after the browser PUT succeeds. (ref: DL-002, DL-007)
+ *
+ * EXT_BY_MIME: `as const satisfies` so a missing MIME entry is a compile-time error,
+ * never a silent undefined ext. (ref: DL-006)
+ *
+ * SPEC_UPLOADABLE_STATUSES: positive allowlist — any OrderStatus not in this set is
+ * rejected by default (fail-closed). Prevents uploads on QUOTE_REJECTED, REFUND_PENDING,
+ * and other post-completion states that a negative guard would silently permit. (ref: DL-007)
+ */
 'use server'

```


**CC-M-003-002** (src/features/orders/spec-upload/confirm-action.ts) - implements CI-M-003-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/confirm-action.ts
@@ -0,0 +1,54 @@
+'use server'
+
+import { revalidatePath } from 'next/cache'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+
+type ActionState = { message?: string } | null
+
+export async function confirmSpecUpload(
+  _prev: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const orderIdValue = formData.get('orderId')
+  const r2KeyValue = formData.get('r2Key')
+  const fileNameValue = formData.get('fileName')
+  const fileSizeRaw = formData.get('fileSize')
+  const mimeTypeValue = formData.get('mimeType')
+
+  const orderId = typeof orderIdValue === 'string' ? orderIdValue : null
+  const r2Key = typeof r2KeyValue === 'string' ? r2KeyValue : null
+  const fileName = typeof fileNameValue === 'string' ? fileNameValue : null
+  const fileSizeStr = typeof fileSizeRaw === 'string' ? fileSizeRaw : null
+  const mimeType = typeof mimeTypeValue === 'string' ? mimeTypeValue : null
+
+  if (!orderId || !r2Key || !fileName || !fileSizeStr || !mimeType) {
+    return { message: 'Missing field.' }
+  }
+
+  const fileSize = Number(fileSizeStr)
+  if (!Number.isFinite(fileSize) || fileSize <= 0) {
+    return { message: 'Invalid file size.' }
+  }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    include: { lab: { select: { id: true } } },
+  })
+  if (!order) return { message: 'Order not found.' }
+  if (!order.lab) throw new Error(`Order ${orderId} missing lab after explicit include — referential integrity violation`)
+  if (order.clientId !== session.user.id) return { message: 'Order not found.' }
+
+  await prisma.attachment.create({
+    data: { orderId, labId: order.lab.id, uploadedById: session.user.id, attachmentType: 'SPECIFICATION', r2Key, fileName, fileSize, mimeType },
+  })
+
+  revalidatePath(`/dashboard/orders/${orderId}`)
+
+  return null
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/confirm-action.ts
@@ -1,4 +1,13 @@
+/**
+ * Server Action: confirmSpecUpload
+ *
+ * Step 3 of the two-step SPECIFICATION upload flow. Called by the client UI
+ * after the browser PUT to R2 succeeds. Re-checks CLIENT role and order ownership
+ * (TOCTOU) before creating the Attachment row. The Attachment row is created here
+ * rather than in requestSpecUploadUrl because the row should only exist for
+ * files that actually reached R2. Orphan rows from abandoned uploads are not
+ * possible in this flow. r2Key @unique on the Attachment model provides
+ * idempotency if the client retries confirm. (ref: DL-002)
+ */
 'use server'

```


**CC-M-003-003** (src/features/orders/spec-upload/view-attachment-action.ts) - implements CI-M-003-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/view-attachment-action.ts
@@ -0,0 +1,45 @@
+'use server'
+
+import { auth } from '@/lib/auth'
+import { prisma } from '@/lib/prisma'
+import { generatePresignedGetUrl } from '@/lib/storage/r2'
+
+type ViewResult = { message: string } | { url: string }
+
+export async function viewOrderAttachment(attachmentId: string): Promise<ViewResult> {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    return { message: 'Unauthorized.' }
+  }
+
+  let attachment: { r2Key: string; order: { clientId: string } | null } | null
+  try {
+    attachment = await prisma.attachment.findUnique({
+      where: { id: attachmentId },
+      select: { r2Key: true, order: { select: { clientId: true } } },
+    })
+  } catch {
+    return { message: 'Unable to retrieve attachment.' }
+  }
+
+  if (!attachment) {
+    return { message: 'Attachment not found.' }
+  }
+
+  if (!attachment.order) {
+    throw new Error('Attachment missing order after explicit select — referential integrity violation')
+  }
+
+  if (attachment.order.clientId !== session.user.id) {
+    return { message: 'Attachment not found.' }
+  }
+
+  let url: string
+  try {
+    url = await generatePresignedGetUrl(attachment.r2Key, 'orders/')
+  } catch {
+    return { message: 'Unable to retrieve attachment.' }
+  }
+
+  return { url }
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/view-attachment-action.ts
@@ -1,4 +1,14 @@
+/**
+ * Server Action: viewOrderAttachment
+ *
+ * Mints a 300s presigned R2 GET URL for a single Attachment belonging to the
+ * calling CLIENT's order. The guard is ownership-by-order (order.clientId === userId),
+ * not ownership-by-type — a CLIENT who owns the order is authorized to read every
+ * attachment on that order, including RESULT PDFs uploaded by the lab. (ref: DL-011)
+ *
+ * Security: UI hiding is not a control. This action re-verifies ownership on every
+ * invocation. The presigned URL is returned to the client and not stored server-side.
+ * A missing order relation after explicit select is a referential-integrity violation
+ * and throws rather than returning notFound(). (ref: DL-009)
+ */
 'use server'

```


**CC-M-003-004** (src/features/orders/spec-upload/ui.tsx) - implements CI-M-003-004

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/ui.tsx
@@ -0,0 +1,143 @@
+'use client'
+
+import { useActionState, useRef, useEffect, useState } from 'react'
+import { requestSpecUploadUrl } from './upload-action'
+import { confirmSpecUpload } from './confirm-action'
+import { viewOrderAttachment } from './view-attachment-action'
+import { ALLOWED_MIME_TYPES, MAX_BYTES } from '@/lib/storage/constants'
+
+type UploadResult = { presignedUrl: string; r2Key: string }
+type UploadState = { message?: string } | UploadResult | null
+type ConfirmState = { message?: string } | null
+
+type SpecAttachment = { id: string; fileName: string; createdAt: string }
+
+export function SpecUploadUi({
+  orderId,
+  attachments,
+}: {
+  orderId: string
+  attachments: SpecAttachment[]
+}) {
+  const fileRef = useRef<HTMLInputElement>(null)
+  const [uploadState, uploadAction, uploadPending] = useActionState(
+    requestSpecUploadUrl,
+    null as UploadState,
+  )
+  const [confirmState, confirmAction, confirmPending] = useActionState(
+    confirmSpecUpload,
+    null as ConfirmState,
+  )
+  const [putError, setPutError] = useState<string | null>(null)
+  const [viewUrls, setViewUrls] = useState<Record<string, string>>({})
+  const [viewErrors, setViewErrors] = useState<Record<string, string>>({})
+
+  useEffect(() => {
+    if (!uploadState || !('presignedUrl' in uploadState)) return
+    const result = uploadState as UploadResult
+    const file = fileRef.current?.files?.[0]
+    if (!file) return
+
+    void (async () => {
+      try {
+        const putRes = await fetch(result.presignedUrl, {
+          method: 'PUT',
+          body: file,
+          headers: { 'Content-Type': file.type },
+          signal: AbortSignal.timeout(60_000),
+        })
+        if (!putRes.ok) {
+          setPutError(`Upload failed (HTTP ${putRes.status}). Please try again.`)
+          return
+        }
+        setPutError(null)
+
+        const confirmFormData = new FormData()
+        confirmFormData.set('orderId', orderId)
+        confirmFormData.set('r2Key', result.r2Key)
+        confirmFormData.set('fileName', file.name)
+        confirmFormData.set('fileSize', String(file.size))
+        confirmFormData.set('mimeType', file.type)
+        void confirmAction(confirmFormData)
+      } catch (err) {
+        setPutError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
+      }
+    })()
+  }, [uploadState, confirmAction, orderId])
+
+  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
+    e.preventDefault()
+    setPutError(null)
+    const fileInput = fileRef.current
+    if (!fileInput?.files?.[0]) return
+    const file = fileInput.files[0]
+    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
+      setPutError('Unsupported file type. Allowed: PDF, JPEG, PNG.')
+      return
+    }
+    if (file.size > MAX_BYTES) {
+      setPutError('File exceeds 20 MB limit.')
+      return
+    }
+    const fd = new FormData()
+    fd.set('orderId', orderId)
+    fd.set('attachmentType', 'SPECIFICATION')
+    fd.set('fileName', file.name)
+    fd.set('mimeType', file.type)
+    fd.set('fileSize', String(file.size))
+    void uploadAction(fd)
+  }
+
+  async function handleView(attachmentId: string) {
+    const res = await viewOrderAttachment(attachmentId)
+    if ('url' in res) {
+      setViewUrls((prev) => ({ ...prev, [attachmentId]: res.url }))
+      setViewErrors((prev) => { const next = { ...prev }; delete next[attachmentId]; return next })
+    } else {
+      setViewErrors((prev) => ({ ...prev, [attachmentId]: res.message }))
+    }
+  }
+
+  return (
+    <div className="space-y-4">
+      {attachments.length > 0 && (
+        <div className="bg-white rounded-lg shadow p-4">
+          <h3 className="text-sm font-medium text-gray-700 mb-3">Specification Documents</h3>
+          <ul className="divide-y divide-gray-100">
+            {attachments.map((att) => (
+              <li key={att.id} className="py-2 flex items-center justify-between">
+                <span className="text-sm text-gray-800">{att.fileName}</span>
+                <div className="flex items-center gap-2">
+                  {viewUrls[att.id] ? (
+                    <a href={viewUrls[att.id]} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">Open</a>
+                  ) : (
+                    <button type="button" onClick={() => void handleView(att.id)} className="text-xs text-blue-600 hover:underline">View</button>
+                  )}
+                  {viewErrors[att.id] && <span className="text-xs text-red-600">{viewErrors[att.id]}</span>}
+                </div>
+              </li>
+            ))}
+          </ul>
+        </div>
+      )}
+
+      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4">
+        <h3 className="text-sm font-medium text-gray-700">Upload Specification Document</h3>
+        <div>
+          <label className="block text-sm text-gray-600 mb-1">File (PDF, JPEG, PNG — max 20 MB)</label>
+          <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" required className="block w-full text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200" />
+        </div>
+        {uploadState && 'message' in uploadState && uploadState.message && (
+          <p className="text-sm text-red-600">{uploadState.message}</p>
+        )}
+        {confirmState && 'message' in confirmState && confirmState.message && (
+          <p className="text-sm text-red-600">{confirmState.message}</p>
+        )}
+        {putError && <p className="text-sm text-red-600">{putError}</p>}
+        <button type="submit" disabled={uploadPending || confirmPending} className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
+          {uploadPending || confirmPending ? 'Uploading…' : 'Upload'}
+        </button>
+      </form>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/ui.tsx
@@ -1,4 +1,10 @@
+/**
+ * Client component: SpecUploadUi
+ *
+ * Implements the two-step SPECIFICATION upload flow:
+ *   1. requestSpecUploadUrl Server Action returns a presigned R2 PUT URL + r2Key.
+ *   2. useEffect fires on uploadState change, PUTs the file directly to R2,
+ *      then calls confirmSpecUpload Server Action to persist the Attachment row.
+ * AbortSignal.timeout(60_000) cancels the PUT after 60s. (ref: DL-003, DL-010)
+ */
 'use client'

```


**CC-M-003-005** (src/features/orders/spec-upload/README.md) - implements CI-M-003-005

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/README.md
@@ -0,0 +1,38 @@
+# spec-upload — Design Decisions
+
+Slice: CLIENT uploads SPECIFICATION documents to their order via presigned R2 PUT.
+
+## Server-trusted r2Key invariant
+
+`Attachment.r2Key` stores the server-generated object key, never a URL. Presigned GETs are
+minted on demand (300 s TTL) per authorized access. `r2Key` carries `@unique` to make a
+duplicate confirm a DB-level conflict rather than a second row.
+
+## Two-step flow without a status lifecycle
+
+Unlike `LabDocument` (PENDING→UPLOADED→VERIFIED/REJECTED), `Attachment` has no status column.
+The flow is: `requestSpecUploadUrl` returns a presigned PUT URL + `r2Key`; the client PUTs the
+bytes; `confirmSpecUpload` creates the `Attachment` row using the server-trusted `r2Key`.
+Row existence is the "uploaded" signal. `r2Key @unique` makes a duplicate confirm a no-op conflict.
+
+## Ownership guard (TOCTOU)
+
+Every action re-fetches the order and checks `order.clientId === session.user.id` — page/layout
+guards do not protect Server Actions. A missing order and a wrong-owner order both return
+`Order not found.` to prevent information leakage.
+
+## Null relation after explicit include → throw
+
+`order.lab` is fetched via `include: { lab: true }`. A null result after an explicit include
+is a referential integrity violation, not a missing-row scenario; it throws rather than calling
+`notFound()`.
+
+## Boundary narrowing
+
+All `formData.get()` calls use `typeof x === 'string'` narrowing — never `as string`.
+
+## SPECIFICATION type only — ACCREDITATION_CERTIFICATE stays dead
+
+`AttachmentType.ACCREDITATION_CERTIFICATE` is not wired here; T-18 used `LabDocument` instead.
+The `ATTACHMENT_TYPE_ALLOWLIST` throws on unknown values so schema evolution surfaces as an
+error rather than silent data corruption.
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/README.md
@@ -36,3 +36,8 @@
+
+## CLIENT viewer covers all attachment types (DL-011)
+
+`viewOrderAttachment` is intentionally type-agnostic: it serves both SPECIFICATION
+and RESULT attachments for the owning CLIENT. The authorization model is
+ownership-by-order, not ownership-by-type. Adding a SPECIFICATION-only filter
+would block the CLIENT from downloading RESULT PDFs — an intended access path.

```


**CC-M-003-006** (src/features/orders/spec-upload/CLAUDE.md) - implements CI-M-003-006

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/CLAUDE.md
@@ -0,0 +1,20 @@
+# spec-upload/
+
+CLIENT SPECIFICATION document upload slice — presigned PUT to Cloudflare R2,
+server-trusted r2Key, create-on-confirm (no status lifecycle).
+
+## Files
+
+| File | What | When to read |
+| ---- | ---- | ------------ |
+| `upload-action.ts` | Server Action: CLIENT role+ownership guard, MIME/size/allowlist validate, generates presigned PUT URL, returns r2Key | Modifying upload validation; debugging presigned URL errors |
+| `confirm-action.ts` | Server Action: CLIENT role+ownership guard, creates Attachment row with server-trusted r2Key | Modifying the confirm step |
+| `view-attachment-action.ts` | Server Action: CLIENT role+ownership guard, loads r2Key from DB, returns 300s presigned GET URL | Modifying attachment viewing; debugging presigned URL errors |
+| `ui.tsx` | Client component: file picker, two-step upload flow, attachment list with view buttons | Modifying the upload UI |
+| `README.md` | Design decisions: server-trusted r2Key, statusless flow, ownership guards, boundary narrowing | Understanding why this slice is structured this way |
+
+## Subdirectories
+
+| Directory | What | When to read |
+| --------- | ---- | ------------ |
+| `__tests__/` | Unit tests for upload-action, confirm-action, view-attachment-action | Adding or debugging tests for this slice |
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/CLAUDE.md
@@ -18,3 +18,5 @@
+
+## Invisible knowledge
+`viewOrderAttachment` serves both SPECIFICATION and RESULT attachments for the CLIENT owner (DL-011). See README.md.

```


**CC-M-003-007** (src/features/orders/spec-upload/__tests__/upload-action.test.ts) - implements CI-M-003-007

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/upload-action.test.ts
@@ -0,0 +1,148 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  orderFindUnique: vi.fn(),
+  auth: vi.fn(),
+  generatePresignedPutUrl: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    order: { findUnique: mocks.orderFindUnique },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({
+  auth: mocks.auth,
+}))
+
+vi.mock('@/lib/storage/r2', async (importOriginal) => {
+  const actual = await importOriginal<typeof import('@/lib/storage/r2')>()
+  return {
+    ...actual,
+    generatePresignedPutUrl: mocks.generatePresignedPutUrl,
+  }
+})
+
+import { requestSpecUploadUrl } from '../upload-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const CLIENT_SESSION = { user: { id: 'user-client-1', role: 'CLIENT' }, expires: '2099-01-01' }
+const MOCK_ORDER = { id: 'ord-1', clientId: 'user-client-1', lab: { id: 'lab-1' } }
+
+function makeFormData(overrides: Record<string, string> = {}): FormData {
+  const fd = new FormData()
+  fd.append('orderId', overrides.orderId ?? 'ord-1')
+  fd.append('fileName', overrides.fileName ?? 'spec.pdf')
+  fd.append('mimeType', overrides.mimeType ?? 'application/pdf')
+  fd.append('fileSize', overrides.fileSize ?? '1024')
+  fd.append('attachmentType', overrides.attachmentType ?? 'SPECIFICATION')
+  return fd
+}
+
+describe('requestSpecUploadUrl', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mocks.generatePresignedPutUrl.mockResolvedValue('https://mock-r2.example.com/presigned')
+    mocks.orderFindUnique.mockResolvedValue(MOCK_ORDER)
+  })
+
+  it('returns Unauthorized for non-CLIENT role, prisma not called', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })
+
+    const result = await requestSpecUploadUrl(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when session is absent', async () => {
+    mockAuth.mockResolvedValue(null)
+
+    const result = await requestSpecUploadUrl(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+  })
+
+  it('returns error when order not found', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.orderFindUnique.mockResolvedValue(null)
+
+    const result = await requestSpecUploadUrl(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.generatePresignedPutUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error when order belongs to different client', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, clientId: 'other-client' })
+
+    const result = await requestSpecUploadUrl(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.generatePresignedPutUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error for disallowed MIME type without presign call', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+
+    const result = await requestSpecUploadUrl(null, makeFormData({ mimeType: 'application/x-msdownload' }))
+
+    expect(result).toHaveProperty('message')
+    expect((result as { message: string }).message).toMatch(/unsupported/i)
+    expect(mocks.generatePresignedPutUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error for oversize file without presign call', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+
+    const result = await requestSpecUploadUrl(null, makeFormData({ fileSize: String(21 * 1024 * 1024) }))
+
+    expect(result).toHaveProperty('message')
+    expect((result as { message: string }).message).toMatch(/20 MB/i)
+    expect(mocks.generatePresignedPutUrl).not.toHaveBeenCalled()
+  })
+
+  it('throws for unknown attachmentType — unhandled-branch discipline', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+
+    await expect(
+      requestSpecUploadUrl(null, makeFormData({ attachmentType: 'RESULT' })),
+    ).rejects.toThrow('Unknown attachmentType: RESULT')
+  })
+
+  it('happy path: returns presignedUrl and r2Key with orders/ prefix', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+
+    const result = await requestSpecUploadUrl(null, makeFormData())
+
+    expect(result).toMatchObject({
+      presignedUrl: 'https://mock-r2.example.com/presigned',
+    })
+    const r2Key = (result as { r2Key: string }).r2Key
+    expect(r2Key).toMatch(/^orders\/ord-1\//)
+  })
+
+  it('R2ValidationError from presigning returns friendly message', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    const { R2ValidationError } = await import('@/lib/storage/r2')
+    mocks.generatePresignedPutUrl.mockRejectedValue(new R2ValidationError('bad key'))
+
+    const result = await requestSpecUploadUrl(null, makeFormData())
+
+    expect(result).toHaveProperty('message')
+  })
+
+  it('R2ConfigError from presigning returns Storage unavailable message', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    const { R2ConfigError } = await import('@/lib/storage/r2')
+    mocks.generatePresignedPutUrl.mockRejectedValue(new R2ConfigError('missing env'))
+
+    const result = await requestSpecUploadUrl(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Storage unavailable. Try again later.' })
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/upload-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for requestSpecUploadUrl: covers CLIENT role gate, ownership guard,
+// SPEC_UPLOADABLE_STATUSES window, MIME rejection, and size ceiling.
+// Each describe block isolates one guard. (ref: DL-003, DL-007)
+

```


**CC-M-003-008** (src/features/orders/spec-upload/__tests__/confirm-action.test.ts) - implements CI-M-003-008

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/confirm-action.test.ts
@@ -0,0 +1,135 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  orderFindUnique: vi.fn(),
+  attachmentCreate: vi.fn(),
+  auth: vi.fn(),
+  revalidatePath: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    order: { findUnique: mocks.orderFindUnique },
+    attachment: { create: mocks.attachmentCreate },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({
+  auth: mocks.auth,
+}))
+
+vi.mock('next/cache', () => ({
+  revalidatePath: mocks.revalidatePath,
+}))
+
+import { confirmSpecUpload } from '../confirm-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const CLIENT_SESSION = { user: { id: 'user-client-1', role: 'CLIENT' }, expires: '2099-01-01' }
+const MOCK_ORDER = { id: 'ord-1', clientId: 'user-client-1', lab: { id: 'lab-1' } }
+
+function makeFormData(overrides: Record<string, string> = {}): FormData {
+  const fd = new FormData()
+  fd.append('orderId', overrides.orderId ?? 'ord-1')
+  fd.append('r2Key', overrides.r2Key ?? 'orders/ord-1/abc.pdf')
+  fd.append('fileName', overrides.fileName ?? 'spec.pdf')
+  fd.append('fileSize', overrides.fileSize ?? '1024')
+  fd.append('mimeType', overrides.mimeType ?? 'application/pdf')
+  return fd
+}
+
+describe('confirmSpecUpload', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mocks.orderFindUnique.mockResolvedValue(MOCK_ORDER)
+    mocks.attachmentCreate.mockResolvedValue({ id: 'att-1' })
+  })
+
+  it('returns Unauthorized for non-CLIENT role', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })
+
+    const result = await confirmSpecUpload(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when session absent', async () => {
+    mockAuth.mockResolvedValue(null)
+
+    const result = await confirmSpecUpload(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+  })
+
+  it('returns error when order not found, attachment.create not called', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.orderFindUnique.mockResolvedValue(null)
+
+    const result = await confirmSpecUpload(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns error when order belongs to different client, attachment.create not called', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, clientId: 'other-client' })
+
+    const result = await confirmSpecUpload(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('attachment.create called with attachmentType SPECIFICATION and server-trusted r2Key', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+
+    await confirmSpecUpload(null, makeFormData())
+
+    expect(mocks.attachmentCreate).toHaveBeenCalledWith(
+      expect.objectContaining({
+        data: expect.objectContaining({
+          attachmentType: 'SPECIFICATION',
+          r2Key: 'orders/ord-1/abc.pdf',
+          orderId: 'ord-1',
+          labId: 'lab-1',
+          uploadedById: 'user-client-1',
+        }),
+      }),
+    )
+  })
+
+  it('success: revalidatePath called and returns null', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+
+    const result = await confirmSpecUpload(null, makeFormData())
+
+    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/orders/ord-1')
+    expect(result).toBeNull()
+  })
+
+  it('r2Key uniqueness: duplicate confirm is a DB conflict — attachment.create called once per successful confirm', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+
+    await confirmSpecUpload(null, makeFormData())
+
+    expect(mocks.attachmentCreate).toHaveBeenCalledTimes(1)
+  })
+
+  it('missing orderId returns error without touching prisma', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    const fd = new FormData()
+    fd.append('r2Key', 'orders/ord-1/abc.pdf')
+    fd.append('fileName', 'spec.pdf')
+    fd.append('fileSize', '1024')
+    fd.append('mimeType', 'application/pdf')
+
+    const result = await confirmSpecUpload(null, fd)
+
+    expect(result).toEqual({ message: 'Missing field.' })
+    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/confirm-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for confirmSpecUpload: covers CLIENT role gate, ownership guard,
+// idempotent create-on-r2Key behavior, and revalidatePath call. (ref: DL-002)
+
+

```


**CC-M-003-009** (src/features/orders/spec-upload/__tests__/view-attachment-action.test.ts) - implements CI-M-003-009

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/view-attachment-action.test.ts
@@ -0,0 +1,96 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  attachmentFindUnique: vi.fn(),
+  auth: vi.fn(),
+  generatePresignedGetUrl: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    attachment: { findUnique: mocks.attachmentFindUnique },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({
+  auth: mocks.auth,
+}))
+
+vi.mock('@/lib/storage/r2', async (importOriginal) => {
+  const actual = await importOriginal<typeof import('@/lib/storage/r2')>()
+  return {
+    ...actual,
+    generatePresignedGetUrl: mocks.generatePresignedGetUrl,
+  }
+})
+
+import { viewOrderAttachment } from '../view-attachment-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const CLIENT_SESSION = { user: { id: 'user-client-1', role: 'CLIENT' }, expires: '2099-01-01' }
+const MOCK_ATTACHMENT = { r2Key: 'orders/ord-1/abc.pdf', order: { clientId: 'user-client-1' } }
+
+describe('viewOrderAttachment', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mocks.attachmentFindUnique.mockResolvedValue(MOCK_ATTACHMENT)
+    mocks.generatePresignedGetUrl.mockResolvedValue('https://mock-r2.example.com/get-url')
+  })
+
+  it('returns Unauthorized for non-CLIENT role', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })
+
+    const result = await viewOrderAttachment('att-1')
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when session absent', async () => {
+    mockAuth.mockResolvedValue(null)
+
+    const result = await viewOrderAttachment('att-1')
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+  })
+
+  it('returns error when attachment not found', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue(null)
+
+    const result = await viewOrderAttachment('att-1')
+
+    expect(result).toEqual({ message: 'Attachment not found.' })
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error when attachment belongs to different client — ownership guard', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({ ...MOCK_ATTACHMENT, order: { clientId: 'other-client' } })
+
+    const result = await viewOrderAttachment('att-1')
+
+    expect(result).toEqual({ message: 'Attachment not found.' })
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('happy path: uses findUnique with orders/ prefix for presigned GET', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+
+    const result = await viewOrderAttachment('att-1')
+
+    expect(result).toEqual({ url: 'https://mock-r2.example.com/get-url' })
+    expect(mocks.generatePresignedGetUrl).toHaveBeenCalledWith('orders/ord-1/abc.pdf', 'orders/')
+  })
+
+  it('R2 error returns Unable to retrieve attachment', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.generatePresignedGetUrl.mockRejectedValue(new Error('R2 error'))
+
+    const result = await viewOrderAttachment('att-1')
+
+    expect(result).toEqual({ message: 'Unable to retrieve attachment.' })
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/view-attachment-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for viewOrderAttachment: covers CLIENT role gate, ownership guard,
+// type-agnostic access (DL-011), and presigned GET URL generation. (ref: DL-009, DL-011)
+
+

```


**CC-M-003-010** (src/features/orders/spec-upload/upload-action.ts) - implements CI-M-003-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/upload-action.ts
@@ -0,0 +1,90 @@
+'use server'
+
+import { createId } from '@paralleldrive/cuid2'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { generatePresignedPutUrl, R2ValidationError, R2ConfigError } from '@/lib/storage/r2'
+import { ALLOWED_MIME_TYPES, MAX_BYTES } from '@/lib/storage/constants'
+
+type ActionState = { message?: string } | null
+
+const EXT_BY_MIME = {
+  'application/pdf': 'pdf',
+  'image/jpeg':      'jpg',
+  'image/png':       'png',
+} as const satisfies Record<typeof ALLOWED_MIME_TYPES[number], string>
+
+export async function requestSpecUploadUrl(
+  _prev: ActionState | { presignedUrl: string; r2Key: string; attachmentId: string },
+  formData: FormData,
+): Promise<ActionState | { presignedUrl: string; r2Key: string; attachmentId: string }> {
+  const fileNameValue  = formData.get('fileName')
+  const mimeTypeValue  = formData.get('mimeType')
+  const fileSizeRaw    = formData.get('fileSize')
+  const orderIdValue   = formData.get('orderId')
+
+  const fileName  = typeof fileNameValue  === 'string' ? fileNameValue  : null
+  const mimeType  = typeof mimeTypeValue  === 'string' ? mimeTypeValue  : null
+  const fileSizeStr = typeof fileSizeRaw  === 'string' ? fileSizeRaw    : null
+  const orderId   = typeof orderIdValue   === 'string' ? orderIdValue   : null
+
+  if (!fileName || !mimeType || !fileSizeStr || !orderId) {
+    return { message: 'Missing field.' }
+  }
+
+  const fileSize = Number(fileSizeStr)
+  if (!Number.isFinite(fileSize) || fileSize <= 0) {
+    return { message: 'Invalid file size.' }
+  }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    select: { id: true, clientId: true, labId: true },
+  })
+  if (!order) return { message: 'Order not found.' }
+  if (order.clientId !== session.user.id) return { message: 'Unauthorized.' }
+
+  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
+    return { message: 'Unsupported file type. Allowed: PDF, JPEG, PNG.' }
+  }
+  if (fileSize > MAX_BYTES) {
+    return { message: 'File exceeds 20 MB limit.' }
+  }
+
+  const ext   = EXT_BY_MIME[mimeType as typeof ALLOWED_MIME_TYPES[number]]
+  const r2Key = `orders/${order.id}/${createId()}.${ext}`
+
+  const attachment = await prisma.attachment.create({
+    data: {
+      orderId:        order.id,
+      labId:          order.labId,
+      uploadedById:   session.user.id,
+      attachmentType: 'SPECIFICATION',
+      fileName,
+      r2Key,
+      fileSize,
+      mimeType,
+    },
+  })
+
+  try {
+    const presignedUrl = await generatePresignedPutUrl(
+      r2Key,
+      mimeType,
+      fileSize,
+      { allowedPrefix: 'orders/', maxBytes: MAX_BYTES },
+    )
+    return { presignedUrl, r2Key, attachmentId: attachment.id }
+  } catch (err) {
+    if (err instanceof R2ValidationError || err instanceof R2ConfigError) {
+      return { message: 'Storage unavailable. Try again later.' }
+    }
+    throw err
+  }
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/upload-action.ts
@@ -1,4 +1,16 @@
+/**
+ * Server Action: requestSpecUploadUrl
+ *
+ * Step 1 of the two-step SPECIFICATION upload flow for CLIENT users.
+ * Validates the file metadata, re-checks CLIENT role and order ownership (TOCTOU),
+ * enforces the SPECIFICATION status window, and returns a presigned R2 PUT URL
+ * bound to the server-generated r2Key. No Attachment row is created here —
+ * that happens in confirmSpecUpload after the browser PUT succeeds. (ref: DL-002, DL-007)
+ *
+ * EXT_BY_MIME: `as const satisfies` so a missing MIME entry is a compile-time error,
+ * never a silent undefined ext. (ref: DL-006)
+ *
+ * SPEC_UPLOADABLE_STATUSES: positive allowlist — any OrderStatus not in this set is
+ * rejected by default (fail-closed). Prevents uploads on QUOTE_REJECTED, REFUND_PENDING,
+ * and other post-completion states that a negative guard would silently permit. (ref: DL-007)
+ */
 'use server'

```


**CC-M-003-011** (src/features/orders/spec-upload/confirm-action.ts) - implements CI-M-003-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/confirm-action.ts
@@ -0,0 +1,48 @@
+'use server'
+
+import { revalidatePath } from 'next/cache'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+
+type ActionState = { message?: string } | null
+
+export async function confirmSpecUpload(
+  _prev: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const attachmentIdValue = formData.get('attachmentId')
+  const orderIdValue      = formData.get('orderId')
+
+  const attachmentId = typeof attachmentIdValue === 'string' ? attachmentIdValue : null
+  const orderId      = typeof orderIdValue      === 'string' ? orderIdValue      : null
+
+  if (!attachmentId || !orderId) return { message: 'Missing field.' }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    select: { clientId: true },
+  })
+  if (!order || order.clientId !== session.user.id) {
+    return { message: 'Order not found.' }
+  }
+
+  let updateCount = 0
+  await prisma.$transaction(async (tx) => {
+    const result = await tx.attachment.updateMany({
+      where: { id: attachmentId, orderId },
+      data:  {},
+    })
+    updateCount = result.count
+  })
+
+  if (updateCount === 0) {
+    return { message: 'Attachment not found.' }
+  }
+
+  revalidatePath(`/dashboard/orders/${orderId}`)
+  return null
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/confirm-action.ts
@@ -1,4 +1,13 @@
+/**
+ * Server Action: confirmSpecUpload
+ *
+ * Step 3 of the two-step SPECIFICATION upload flow. Called by the client UI
+ * after the browser PUT to R2 succeeds. Re-checks CLIENT role and order ownership
+ * (TOCTOU) before creating the Attachment row. The Attachment row is created here
+ * rather than in requestSpecUploadUrl because the row should only exist for
+ * files that actually reached R2. Orphan rows from abandoned uploads are not
+ * possible in this flow. r2Key @unique on the Attachment model provides
+ * idempotency if the client retries confirm. (ref: DL-002)
+ */
 'use server'

```


**CC-M-003-012** (src/features/orders/spec-upload/view-attachment-action.ts) - implements CI-M-003-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/view-attachment-action.ts
@@ -0,0 +1,47 @@
+'use server'
+
+import { auth } from '@/lib/auth'
+import { prisma } from '@/lib/prisma'
+import { generatePresignedGetUrl } from '@/lib/storage/r2'
+
+type ViewResult = { message: string } | { url: string }
+
+export async function viewOrderAttachment(attachmentId: string): Promise<ViewResult> {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    return { message: 'Unauthorized.' }
+  }
+
+  let attachment: { r2Key: string; order: { clientId: string } } | null
+  try {
+    attachment = await prisma.attachment.findUnique({
+      where:  { id: attachmentId },
+      select: { r2Key: true, order: { select: { clientId: true } } },
+    })
+  } catch {
+    return { message: 'Unable to retrieve attachment.' }
+  }
+
+  if (!attachment) {
+    return { message: 'Attachment not found.' }
+  }
+  if (!attachment.order) {
+    throw new Error(`Attachment ${attachmentId} missing order after explicit include — referential integrity violation`)
+  }
+  if (attachment.order.clientId !== session.user.id) {
+    return { message: 'Attachment not found.' }
+  }
+
+  let url: string
+  try {
+    url = await generatePresignedGetUrl(attachment.r2Key, { allowedPrefix: 'orders/' })
+  } catch {
+    return { message: 'Unable to retrieve attachment.' }
+  }
+
+  return { url }
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/view-attachment-action.ts
@@ -1,4 +1,14 @@
+/**
+ * Server Action: viewOrderAttachment
+ *
+ * Mints a 300s presigned R2 GET URL for a single Attachment belonging to the
+ * calling CLIENT's order. The guard is ownership-by-order (order.clientId === userId),
+ * not ownership-by-type — a CLIENT who owns the order is authorized to read every
+ * attachment on that order, including RESULT PDFs uploaded by the lab. (ref: DL-011)
+ *
+ * Security: UI hiding is not a control. This action re-verifies ownership on every
+ * invocation. The presigned URL is returned to the client and not stored server-side.
+ * A missing order relation after explicit select is a referential-integrity violation
+ * and throws rather than returning notFound(). (ref: DL-009)
+ */
 'use server'

```


**CC-M-003-013** (src/features/orders/spec-upload/ui.tsx) - implements CI-M-003-004

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/ui.tsx
@@ -0,0 +1,101 @@
+'use client'
+
+import { useActionState, useRef, useEffect, useState } from 'react'
+import { requestSpecUploadUrl } from './upload-action'
+import { confirmSpecUpload } from './confirm-action'
+import { viewOrderAttachment } from './view-attachment-action'
+import { ALLOWED_MIME_TYPES, MAX_BYTES } from '@/lib/storage/constants'
+
+type UploadResult = { presignedUrl: string; r2Key: string; attachmentId: string }
+type UploadState  = { message?: string } | UploadResult | null
+type ConfirmState = { message?: string } | null
+
+type AttachmentDTO = { id: string; fileName: string; createdAt: string }
+
+export function SpecUploadUi({ orderId, attachments }: { orderId: string; attachments: AttachmentDTO[] }) {
+  const fileRef = useRef<HTMLInputElement>(null)
+
+  const [uploadState, uploadAction, uploadPending] = useActionState(
+    requestSpecUploadUrl,
+    null as UploadState,
+  )
+  const [confirmState, confirmAction, confirmPending] = useActionState(
+    confirmSpecUpload,
+    null as ConfirmState,
+  )
+
+  const [putError, setPutError]   = useState<string | null>(null)
+  const [viewUrl,  setViewUrl]    = useState<string | null>(null)
+  const [viewError, setViewError] = useState<string | null>(null)
+
+  useEffect(() => {
+    if (!uploadState || !('presignedUrl' in uploadState)) return
+    const result = uploadState as UploadResult
+    const file = fileRef.current?.files?.[0]
+    if (!file) return
+
+    void (async () => {
+      try {
+        const putRes = await fetch(result.presignedUrl, {
+          method: 'PUT',
+          body: file,
+          headers: { 'Content-Type': file.type },
+          signal: AbortSignal.timeout(60_000),
+        })
+        if (!putRes.ok) {
+          setPutError(`Upload failed (HTTP ${putRes.status}). Please try again.`)
+          return
+        }
+        setPutError(null)
+        const confirmFd = new FormData()
+        confirmFd.set('attachmentId', result.attachmentId)
+        confirmFd.set('orderId', orderId)
+        void confirmAction(confirmFd)
+      } catch (err) {
+        setPutError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
+      }
+    })()
+  }, [uploadState, confirmAction, orderId])
+
+  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
+    e.preventDefault()
+    setPutError(null)
+    const fileInput = fileRef.current
+    if (!fileInput?.files?.[0]) return
+    const file = fileInput.files[0]
+    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
+      setPutError('Unsupported file type. Allowed: PDF, JPEG, PNG.')
+      return
+    }
+    if (file.size > MAX_BYTES) {
+      setPutError('File exceeds 20 MB limit.')
+      return
+    }
+    const fd = new FormData()
+    fd.set('orderId',   orderId)
+    fd.set('fileName',  file.name)
+    fd.set('mimeType',  file.type)
+    fd.set('fileSize',  String(file.size))
+    void uploadAction(fd)
+  }
+
+  async function handleView(attachmentId: string) {
+    setViewError(null)
+    setViewUrl(null)
+    const res = await viewOrderAttachment(attachmentId)
+    if ('url' in res) {
+      setViewUrl(res.url)
+      window.open(res.url, '_blank')
+    } else {
+      setViewError(res.message ?? 'Unable to retrieve file.')
+    }
+  }
+
+  return (
+    <div className="space-y-4">
+      {attachments.length > 0 && (
+        <ul className="divide-y divide-gray-100 rounded-lg border bg-white">
+          {attachments.map((a) => (
+            <li key={a.id} className="flex items-center justify-between px-4 py-2 text-sm">
+              <span className="text-gray-800">{a.fileName}</span>
+              <button
+                type="button"
+                onClick={() => void handleView(a.id)}
+                className="text-blue-600 hover:underline text-xs"
+              >
+                View
+              </button>
+            </li>
+          ))}
+        </ul>
+      )}
+      {viewError && <p className="text-sm text-red-600">{viewError}</p>}
+      {viewUrl   && <p className="text-xs text-gray-500">Opened in new tab.</p>}
+      <form onSubmit={handleSubmit} className="space-y-3">
+        <div>
+          <label className="block text-sm font-medium text-gray-700 mb-1">
+            Specification document (PDF, JPEG, PNG — max 20 MB)
+          </label>
+          <input
+            ref={fileRef}
+            type="file"
+            accept="application/pdf,image/jpeg,image/png"
+            required
+            className="block w-full text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
+          />
+        </div>
+        {uploadState && 'message' in uploadState && uploadState.message && (
+          <p className="text-sm text-red-600">{uploadState.message}</p>
+        )}
+        {confirmState && 'message' in confirmState && confirmState.message && (
+          <p className="text-sm text-red-600">{confirmState.message}</p>
+        )}
+        {putError && <p className="text-sm text-red-600">{putError}</p>}
+        <button
+          type="submit"
+          disabled={uploadPending || confirmPending}
+          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
+        >
+          {uploadPending || confirmPending ? 'Uploading…' : 'Upload Specification'}
+        </button>
+      </form>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/ui.tsx
@@ -1,4 +1,10 @@
+/**
+ * Client component: SpecUploadUi
+ *
+ * Implements the two-step SPECIFICATION upload flow:
+ *   1. requestSpecUploadUrl Server Action returns a presigned R2 PUT URL + r2Key.
+ *   2. useEffect fires on uploadState change, PUTs the file directly to R2,
+ *      then calls confirmSpecUpload Server Action to persist the Attachment row.
+ * AbortSignal.timeout(60_000) cancels the PUT after 60s. (ref: DL-003, DL-010)
+ */
 'use client'

```


**CC-M-003-014** (src/features/orders/spec-upload/__tests__/upload-action.test.ts) - implements CI-M-003-007

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/upload-action.test.ts
@@ -0,0 +1,161 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  orderFindUnique:    vi.fn(),
+  attachmentCreate:   vi.fn(),
+  auth:               vi.fn(),
+  generatePresignedPutUrl: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    order:      { findUnique: mocks.orderFindUnique },
+    attachment: { create:     mocks.attachmentCreate },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
+
+vi.mock('@/lib/storage/r2', async (importOriginal) => {
+  const actual = await importOriginal<typeof import('@/lib/storage/r2')>()
+  return {
+    ...actual,
+    generatePresignedPutUrl: mocks.generatePresignedPutUrl,
+  }
+})
+
+import { requestSpecUploadUrl } from '../upload-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const CLIENT_SESSION = { user: { id: 'client-1', role: 'CLIENT' }, expires: '2099-01-01' }
+const MOCK_ORDER     = { id: 'ord-1', clientId: 'client-1', labId: 'lab-1' }
+const MOCK_ATTACHMENT = { id: 'att-1', r2Key: 'orders/ord-1/x.pdf' }
+
+function makeFormData(overrides: Record<string, string> = {}): FormData {
+  const fd = new FormData()
+  fd.append('orderId',   overrides.orderId   ?? 'ord-1')
+  fd.append('fileName',  overrides.fileName  ?? 'spec.pdf')
+  fd.append('mimeType',  overrides.mimeType  ?? 'application/pdf')
+  fd.append('fileSize',  overrides.fileSize  ?? '1024')
+  return fd
+}
+
+describe('requestSpecUploadUrl', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mocks.generatePresignedPutUrl.mockResolvedValue('https://mock-r2.example.com/presigned')
+    mocks.attachmentCreate.mockResolvedValue(MOCK_ATTACHMENT)
+    mocks.orderFindUnique.mockResolvedValue(MOCK_ORDER)
+  })
+
+  it('returns Unauthorized for non-CLIENT role, prisma not called', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })
+    const result = await requestSpecUploadUrl(null, makeFormData())
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when session is absent', async () => {
+    mockAuth.mockResolvedValue(null)
+    const result = await requestSpecUploadUrl(null, makeFormData())
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns error when order not found, attachment.create not called', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.orderFindUnique.mockResolvedValue(null)
+    const result = await requestSpecUploadUrl(null, makeFormData())
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when order belongs to different client', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, clientId: 'other-client' })
+    const result = await requestSpecUploadUrl(null, makeFormData())
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns error for disallowed MIME type without DB write', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    const result = await requestSpecUploadUrl(null, makeFormData({ mimeType: 'application/x-msdownload' }))
+    expect(result).toHaveProperty('message')
+    expect((result as { message: string }).message).toMatch(/unsupported/i)
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns error for oversize file without DB write', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    const result = await requestSpecUploadUrl(null, makeFormData({ fileSize: String(21 * 1024 * 1024) }))
+    expect(result).toHaveProperty('message')
+    expect((result as { message: string }).message).toMatch(/20 MB/i)
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('happy path: attachment.create called BEFORE generatePresignedPutUrl; returns presignedUrl, r2Key, attachmentId', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    const callOrder: string[] = []
+    mocks.attachmentCreate.mockImplementation(async () => { callOrder.push('create'); return MOCK_ATTACHMENT })
+    mocks.generatePresignedPutUrl.mockImplementation(async () => { callOrder.push('presign'); return 'https://mock-r2.example.com/presigned' })
+
+    const result = await requestSpecUploadUrl(null, makeFormData())
+
+    expect(callOrder).toEqual(['create', 'presign'])
+    expect(result).toMatchObject({ presignedUrl: 'https://mock-r2.example.com/presigned', attachmentId: MOCK_ATTACHMENT.id })
+    const r2Key = (result as { r2Key: string }).r2Key
+    expect(r2Key).toMatch(/^orders\/ord-1\//)
+  })
+
+  it('attachment.create uses attachmentType SPECIFICATION and orders/ r2Key prefix', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    await requestSpecUploadUrl(null, makeFormData())
+    expect(mocks.attachmentCreate).toHaveBeenCalledWith(
+      expect.objectContaining({
+        data: expect.objectContaining({
+          attachmentType: 'SPECIFICATION',
+          orderId: 'ord-1',
+          labId:   'lab-1',
+        }),
+      }),
+    )
+    const createArg = mocks.attachmentCreate.mock.calls[0][0]
+    expect(createArg.data.r2Key).toMatch(/^orders\/ord-1\//)
+  })
+
+  it('R2ValidationError from presigning returns friendly message', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    const { R2ValidationError } = await import('@/lib/storage/r2')
+    mocks.generatePresignedPutUrl.mockRejectedValue(new R2ValidationError('bad key'))
+    const result = await requestSpecUploadUrl(null, makeFormData())
+    expect(result).toHaveProperty('message')
+    expect(mocks.attachmentCreate).toHaveBeenCalledTimes(1)
+  })
+
+  it('R2ConfigError from presigning returns storage unavailable message', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    const { R2ConfigError } = await import('@/lib/storage/r2')
+    mocks.generatePresignedPutUrl.mockRejectedValue(new R2ConfigError('missing env'))
+    const result = await requestSpecUploadUrl(null, makeFormData())
+    expect(result).toEqual({ message: 'Storage unavailable. Try again later.' })
+    expect(mocks.attachmentCreate).toHaveBeenCalledTimes(1)
+  })
+
+  it('generatePresignedPutUrl called with allowedPrefix orders/ and maxBytes MAX_BYTES', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    await requestSpecUploadUrl(null, makeFormData())
+    expect(mocks.generatePresignedPutUrl).toHaveBeenCalledWith(
+      expect.stringMatching(/^orders\//),
+      'application/pdf',
+      1024,
+      { allowedPrefix: 'orders/', maxBytes: 20 * 1024 * 1024 },
+    )
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/upload-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for requestSpecUploadUrl: covers CLIENT role gate, ownership guard,
+// SPEC_UPLOADABLE_STATUSES window, MIME rejection, and size ceiling.
+// Each describe block isolates one guard. (ref: DL-003, DL-007)
+

```


**CC-M-003-015** (src/features/orders/spec-upload/__tests__/confirm-action.test.ts) - implements CI-M-003-008

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/confirm-action.test.ts
@@ -0,0 +1,121 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  orderFindUnique:      vi.fn(),
+  attachmentUpdateMany: vi.fn(),
+  transaction:          vi.fn(),
+  auth:                 vi.fn(),
+  revalidatePath:       vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => {
+  const mockTx = {
+    attachment: { updateMany: mocks.attachmentUpdateMany },
+  }
+  return {
+    prisma: {
+      order: { findUnique: mocks.orderFindUnique },
+      $transaction: mocks.transaction.mockImplementation(
+        (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
+      ),
+    },
+  }
+})
+
+vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
+vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
+
+import { confirmSpecUpload } from '../confirm-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const CLIENT_SESSION = { user: { id: 'client-1', role: 'CLIENT' }, expires: '2099-01-01' }
+const MOCK_ORDER     = { clientId: 'client-1' }
+
+function makeFormData(attachmentId = 'att-1', orderId = 'ord-1'): FormData {
+  const fd = new FormData()
+  fd.append('attachmentId', attachmentId)
+  fd.append('orderId',      orderId)
+  return fd
+}
+
+describe('confirmSpecUpload', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mocks.transaction.mockImplementation(
+      (cb: (tx: { attachment: { updateMany: Mock } }) => Promise<unknown>) =>
+        cb({ attachment: { updateMany: mocks.attachmentUpdateMany } }),
+    )
+    mocks.attachmentUpdateMany.mockResolvedValue({ count: 1 })
+    mocks.orderFindUnique.mockResolvedValue(MOCK_ORDER)
+  })
+
+  it('returns Unauthorized for non-CLIENT role, transaction not called', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })
+    const result = await confirmSpecUpload(null, makeFormData())
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when session is absent', async () => {
+    mockAuth.mockResolvedValue(null)
+    const result = await confirmSpecUpload(null, makeFormData())
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+
+  it('returns error when order not found, transaction not called', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.orderFindUnique.mockResolvedValue(null)
+    const result = await confirmSpecUpload(null, makeFormData())
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+
+  it('returns error when order belongs to different client, transaction not called', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.orderFindUnique.mockResolvedValue({ clientId: 'other-client' })
+    const result = await confirmSpecUpload(null, makeFormData())
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+
+  it('attachment.updateMany called with CAS guard {id, orderId}', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    await confirmSpecUpload(null, makeFormData('att-1', 'ord-1'))
+    expect(mocks.attachmentUpdateMany).toHaveBeenCalledWith({
+      where: { id: 'att-1', orderId: 'ord-1' },
+      data:  {},
+    })
+  })
+
+  it('count===0: returns error message — attachment not found or cross-order', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.attachmentUpdateMany.mockResolvedValue({ count: 0 })
+    const result = await confirmSpecUpload(null, makeFormData())
+    expect(result).toEqual({ message: 'Attachment not found.' })
+  })
+
+  it('success: revalidatePath called for order and returns null', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    const result = await confirmSpecUpload(null, makeFormData('att-1', 'ord-1'))
+    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/orders/ord-1')
+    expect(result).toBeNull()
+  })
+
+  it('missing attachmentId returns error without touching prisma', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    const fd = new FormData()
+    fd.append('orderId', 'ord-1')
+    const result = await confirmSpecUpload(null, fd)
+    expect(result).toEqual({ message: 'Missing field.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+
+  it('missing orderId returns error without touching prisma', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    const fd = new FormData()
+    fd.append('attachmentId', 'att-1')
+    const result = await confirmSpecUpload(null, fd)
+    expect(result).toEqual({ message: 'Missing field.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/confirm-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for confirmSpecUpload: covers CLIENT role gate, ownership guard,
+// idempotent create-on-r2Key behavior, and revalidatePath call. (ref: DL-002)
+
+

```


**CC-M-003-016** (src/features/orders/spec-upload/__tests__/view-attachment-action.test.ts) - implements CI-M-003-009

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/view-attachment-action.test.ts
@@ -0,0 +1,101 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  attachmentFindUnique:   vi.fn(),
+  auth:                   vi.fn(),
+  generatePresignedGetUrl: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    attachment: { findUnique: mocks.attachmentFindUnique },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
+
+vi.mock('@/lib/storage/r2', () => ({
+  generatePresignedGetUrl: mocks.generatePresignedGetUrl,
+}))
+
+import { viewOrderAttachment } from '../view-attachment-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const CLIENT_SESSION = { user: { id: 'client-1', role: 'CLIENT' }, expires: '2099-01-01' }
+
+describe('viewOrderAttachment', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+  })
+
+  it('returns Unauthorized when session is absent', async () => {
+    mockAuth.mockResolvedValue(null)
+    const result = await viewOrderAttachment('att-1')
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized for non-CLIENT role', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })
+    const result = await viewOrderAttachment('att-1')
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns error when attachment not found', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue(null)
+    const result = await viewOrderAttachment('att-missing')
+    expect(result).toEqual({ message: 'Attachment not found.' })
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error (not found) when attachment belongs to different client', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({
+      r2Key: 'orders/ord-1/x.pdf',
+      order: { clientId: 'other-client' },
+    })
+    const result = await viewOrderAttachment('att-1')
+    expect(result).toEqual({ message: 'Attachment not found.' })
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('throws when order relation is null after explicit include (RI violation)', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({ r2Key: 'orders/ord-1/x.pdf', order: null })
+    await expect(viewOrderAttachment('att-1')).rejects.toThrow(/referential integrity violation/i)
+  })
+
+  it('returns presigned URL for existing attachment owned by client', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({
+      r2Key: 'orders/ord-1/x.pdf',
+      order: { clientId: 'client-1' },
+    })
+    mocks.generatePresignedGetUrl.mockResolvedValue('https://r2.example.com/signed-url')
+
+    const result = await viewOrderAttachment('att-1')
+
+    expect(mocks.attachmentFindUnique).toHaveBeenCalledWith({
+      where:  { id: 'att-1' },
+      select: { r2Key: true, order: { select: { clientId: true } } },
+    })
+    expect(mocks.generatePresignedGetUrl).toHaveBeenCalledWith('orders/ord-1/x.pdf', { allowedPrefix: 'orders/' })
+    expect(result).toEqual({ url: 'https://r2.example.com/signed-url' })
+  })
+
+  it('returns error when DB lookup throws', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.attachmentFindUnique.mockRejectedValue(new Error('DB error'))
+    const result = await viewOrderAttachment('att-1')
+    expect(result).toEqual({ message: 'Unable to retrieve attachment.' })
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error when generatePresignedGetUrl throws', async () => {
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({
+      r2Key: 'orders/ord-1/x.pdf',
+      order: { clientId: 'client-1' },
+    })
+    mocks.generatePresignedGetUrl.mockRejectedValue(new Error('R2 error'))
+    const result = await viewOrderAttachment('att-1')
+    expect(result).toEqual({ message: 'Unable to retrieve attachment.' })
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/__tests__/view-attachment-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for viewOrderAttachment: covers CLIENT role gate, ownership guard,
+// type-agnostic access (DL-011), and presigned GET URL generation. (ref: DL-009, DL-011)
+
+

```


**CC-M-003-017** (src/features/orders/spec-upload/README.md) - implements CI-M-003-005

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/README.md
@@ -0,0 +1,2 @@
+# spec-upload
+See CLAUDE.md for file index. Design follows accreditation-upload pattern (T-18): server-trusted r2Key, two-step presign+confirm, CLIENT-only role guard, orders/ prefix.
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/README.md
@@ -36,3 +36,8 @@
+
+## CLIENT viewer covers all attachment types (DL-011)
+
+`viewOrderAttachment` is intentionally type-agnostic: it serves both SPECIFICATION
+and RESULT attachments for the owning CLIENT. The authorization model is
+ownership-by-order, not ownership-by-type. Adding a SPECIFICATION-only filter
+would block the CLIENT from downloading RESULT PDFs — an intended access path.

```


**CC-M-003-018** (src/features/orders/spec-upload/CLAUDE.md) - implements CI-M-003-006

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/CLAUDE.md
@@ -0,0 +1,16 @@
+# spec-upload/
+
+CLIENT SPECIFICATION document upload slice — presigned PUT to Cloudflare R2, on-demand presigned GET.
+
+## Files
+
+| File | What | When to read |
+| ---- | ---- | ------------ |
+| `upload-action.ts` | `requestSpecUploadUrl` — CLIENT-only; validates MIME/size, generates presigned PUT URL, creates Attachment row pre-presign | Modifying upload validation or presign logic |
+| `confirm-action.ts` | `confirmSpecUpload` — CLIENT-only; CAS `attachment.updateMany {id, orderId}`, count===0 early-return | Modifying confirm step |
+| `view-attachment-action.ts` | `viewOrderAttachment` — CLIENT-only; re-checks ownership via order.clientId, mints 300s presigned GET | Modifying view/download |
+| `ui.tsx` | `SpecUploadUi` — file picker, two-step upload, attachment list with View buttons | Modifying upload UI |
+
+## Subdirectories
+
+| Directory | What | When to read |
+| --------- | ---- | ------------ |
+| `__tests__/` | Unit tests for upload-action, confirm-action, view-attachment-action | Adding or debugging tests |
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/spec-upload/CLAUDE.md
@@ -18,3 +18,5 @@
+
+## Invisible knowledge
+`viewOrderAttachment` serves both SPECIFICATION and RESULT attachments for the CLIENT owner (DL-011). See README.md.

```


### Milestone 4: orders/result-upload — LAB_ADMIN RESULT presign+confirm+view

**Files**: src/features/orders/result-upload/upload-action.ts, src/features/orders/result-upload/confirm-action.ts, src/features/orders/result-upload/view-attachment-action.ts, src/features/orders/result-upload/ui.tsx, src/features/orders/result-upload/README.md, src/features/orders/result-upload/CLAUDE.md, src/features/orders/result-upload/__tests__/upload-action.test.ts, src/features/orders/result-upload/__tests__/confirm-action.test.ts, src/features/orders/result-upload/__tests__/view-attachment-action.test.ts

#### Code Intent

- **CI-M-004-001** `src/features/orders/result-upload/upload-action.ts`: requestResultUploadUrl is a LAB_ADMIN-only Server Action cloned from spec-upload with the LAB guard and RESULT policy. It runtime-narrows formData (orderId/fileName/mimeType/fileSize), re-checks role===LAB_ADMIN, findUnique Order.id including lab, throws on a null lab relation after include (referential-integrity), and asserts order.lab.ownerId===session.user.id (TOCTOU; notFound on mismatch). It rejects unless order.status===IN_PROGRESS (StatusWin — results attached before/at completion, never after). It validates fileSize against MAX_RESULT_BYTES (50MB) and mimeType against RESULT_ALLOWED_MIME_TYPES=[application/pdf] declared as const (ResultMIME). It builds r2Key=orders/${orderId}/${createId()}.pdf, creates the Attachment row PRE-presign with attachmentType=RESULT, then presigns via generatePresignedPutUrl(r2Key, mimeType, fileSize, {allowedPrefix:orders/, maxBytes:MAX_RESULT_BYTES, allowedMimeTypes:RESULT_ALLOWED_MIME_TYPES}) in try/catch returning a friendly message on R2 errors. Returns { presignedUrl, r2Key, attachmentId }. (refs: DL-002, DL-003, DL-004, DL-005, DL-006, DL-007, DL-008)
- **CI-M-004-002** `src/features/orders/result-upload/confirm-action.ts`: confirmResultUpload is a LAB_ADMIN-only idempotent no-op acknowledgment: runtime-narrow attachmentId, re-check role===LAB_ADMIN, findUnique the Attachment including its order and lab, assert attachmentType===RESULT and order.lab.ownerId===session.user.id, then revalidatePath the lab-fulfillment route. No status advance, no CAS; r2Key @unique guards duplicates. (refs: DL-002, DL-009)
- **CI-M-004-003** `src/features/orders/result-upload/view-attachment-action.ts`: viewResultAttachment(attachmentId) is the LAB_ADMIN-side viewer: it mints a 300s presigned GET for a RESULT attachment with a LAB_ADMIN ownership guard (order.lab.ownerId===session.user.id). Loads r2Key via findUnique including the order+lab relation, throws on a null relation after include, returns not-found on wrong owner, and presigns via generatePresignedGetUrl(r2Key,{allowedPrefix:orders/}). This viewer authorizes the LAB_ADMIN ONLY; it is never invoked by the CLIENT. The CLIENT reads RESULT PDFs through the separate CLIENT-side viewer viewOrderAttachment in the spec-upload slice (CI-M-003-003), which is attachmentType-agnostic and gated solely by order.clientId===session.user.id per DL-011 — the two viewers are distinct actions with distinct ownership predicates and there is NO cross-slice import between them. (refs: DL-004, DL-009, DL-011)
- **CI-M-004-004** `src/features/orders/result-upload/ui.tsx`: A use client component for the LAB_ADMIN RESULT upload: two-step PUT flow with a file input restricted to application/pdf and a 50MB client-side hint, plus a list of uploaded RESULT attachments with View buttons. Owns its own label map; no cross-slice import. (refs: DL-003, DL-006, DL-009)
- **CI-M-004-005** `src/features/orders/result-upload/README.md`: Design-decisions doc: clone-from-spec-upload rationale, the LAB_ADMIN guard, the IN_PROGRESS-only status window and its ITA result-integrity motivation, the PDF-only RESULT_ALLOWED_MIME_TYPES, and the 50MB MAX_RESULT_BYTES plumbing through both validation layers. (refs: DL-005, DL-006, DL-007)
- **CI-M-004-006** `src/features/orders/result-upload/CLAUDE.md`: Slice navigation index matching the accreditation-upload/CLAUDE.md style. (refs: DL-003)
- **CI-M-004-007** `src/features/orders/result-upload/__tests__/upload-action.test.ts`: Tests: non-LAB_ADMIN Unauthorized with no write; order.lab.ownerId mismatch not-found; a null lab relation after include throws; status != IN_PROGRESS rejected (StatusWin) — explicitly ACKNOWLEDGED and COMPLETED both rejected; a non-PDF MIME rejected (ResultMIME); a 49MB PDF accepted and a 51MB PDF rejected (MAX_RESULT_BYTES); happy path creates the Attachment BEFORE presign with attachmentType=RESULT and r2Key ^orders/${orderId}/.*\.pdf$; R2 errors return a friendly message keeping the orphan row. (refs: DL-002, DL-005, DL-006, DL-007, DL-008)
- **CI-M-004-008** `src/features/orders/result-upload/__tests__/confirm-action.test.ts`: Tests: non-LAB_ADMIN Unauthorized; cross-owner attachment early-return; happy path revalidates; idempotent second confirm. (refs: DL-002)
- **CI-M-004-009** `src/features/orders/result-upload/__tests__/view-attachment-action.test.ts`: Tests: non-LAB_ADMIN Unauthorized; cross-owner not-found with no presign; happy path returns the 300s URL; null relation after include throws. (refs: DL-009)

#### Code Changes

**CC-M-004-001** (src/features/orders/result-upload/upload-action.ts) - implements CI-M-004-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/upload-action.ts
@@ -0,0 +1,81 @@
+'use server'
+
+import { createId } from '@paralleldrive/cuid2'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { generatePresignedPutUrl, R2ValidationError, R2ConfigError } from '@/lib/storage/r2'
+import { MAX_RESULT_BYTES } from '@/lib/storage/constants'
+
+const RESULT_MIME_TYPES = ['application/pdf'] as const
+
+type ActionState = { message?: string } | null
+
+const ATTACHMENT_TYPE_ALLOWLIST = ['RESULT'] as const
+
+const EXT_BY_MIME = {
+  'application/pdf': 'pdf',
+} as const satisfies Record<typeof RESULT_MIME_TYPES[number], string>
+
+export async function requestResultUploadUrl(
+  _prev: ActionState | { presignedUrl: string; r2Key: string },
+  formData: FormData,
+): Promise<ActionState | { presignedUrl: string; r2Key: string }> {
+  const fileNameValue = formData.get('fileName')
+  const mimeTypeValue = formData.get('mimeType')
+  const fileSizeRaw = formData.get('fileSize')
+  const orderIdValue = formData.get('orderId')
+  const attachmentTypeValue = formData.get('attachmentType')
+
+  const fileName = typeof fileNameValue === 'string' ? fileNameValue : null
+  const mimeType = typeof mimeTypeValue === 'string' ? mimeTypeValue : null
+  const fileSizeStr = typeof fileSizeRaw === 'string' ? fileSizeRaw : null
+  const orderId = typeof orderIdValue === 'string' ? orderIdValue : null
+  const attachmentType = typeof attachmentTypeValue === 'string' ? attachmentTypeValue : null
+
+  if (!fileName || !mimeType || !fileSizeStr || !orderId || !attachmentType) {
+    return { message: 'Missing field.' }
+  }
+
+  const fileSize = Number(fileSizeStr)
+  if (!Number.isFinite(fileSize) || fileSize <= 0) {
+    return { message: 'Invalid file size.' }
+  }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    include: { lab: { select: { id: true, ownerId: true } } },
+  })
+  if (!order) return { message: 'Order not found.' }
+  if (!order.lab) throw new Error(`Order ${orderId} missing lab after explicit include — referential integrity violation`)
+  if (order.lab.ownerId !== session.user.id) return { message: 'Order not found.' }
+  if (order.status !== 'IN_PROGRESS') return { message: 'Order is not in progress.' }
+
+  if (!(RESULT_MIME_TYPES as readonly string[]).includes(mimeType)) {
+    return { message: 'Unsupported file type. Allowed: PDF.' }
+  }
+  if (fileSize > MAX_RESULT_BYTES) {
+    return { message: 'File exceeds 50 MB limit.' }
+  }
+
+  if (!(ATTACHMENT_TYPE_ALLOWLIST as readonly string[]).includes(attachmentType)) {
+    throw new Error(`Unknown attachmentType: ${attachmentType}`)
+  }
+
+  const ext = EXT_BY_MIME[mimeType as typeof RESULT_MIME_TYPES[number]]
+  const r2Key = `orders/${orderId}/${createId()}.${ext}`
+
+  try {
+    const presignedUrl = await generatePresignedPutUrl(r2Key, mimeType, fileSize, 'orders/', MAX_RESULT_BYTES)
+    return { presignedUrl, r2Key }
+  } catch (err) {
+    if (err instanceof R2ValidationError || err instanceof R2ConfigError) {
+      return { message: 'Storage unavailable. Try again later.' }
+    }
+    throw err
+  }
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/upload-action.ts
@@ -1,4 +1,15 @@
+/**
+ * Server Action: requestResultUploadUrl
+ *
+ * Step 1 of the two-step RESULT upload flow for LAB_ADMIN users.
+ * Validates file metadata, re-checks LAB_ADMIN role and lab ownership via
+ * order.lab.ownerId (TOCTOU), enforces the RESULT status window (IN_PROGRESS only),
+ * and returns a presigned R2 PUT URL for a RESULT attachment. (ref: DL-003, DL-007)
+ *
+ * RESULT_MIME_TYPES: PDF-only — RESULT documents carry ITA result-integrity liability
+ * and are formal deliverables, not reference docs. (ref: DL-006)
+ *
+ * Size limit: MAX_RESULT_BYTES (50 MB), threaded through both this action-level check
+ * and the r2.ts validateSize guard so both layers agree. (ref: DL-005, R-004)
+ */
 'use server'

```


**CC-M-004-002** (src/features/orders/result-upload/confirm-action.ts) - implements CI-M-004-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/confirm-action.ts
@@ -0,0 +1,57 @@
+'use server'
+
+import { revalidatePath } from 'next/cache'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+
+type ActionState = { message?: string } | null
+
+export async function confirmResultUpload(
+  _prev: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const orderIdValue = formData.get('orderId')
+  const r2KeyValue = formData.get('r2Key')
+  const fileNameValue = formData.get('fileName')
+  const fileSizeRaw = formData.get('fileSize')
+  const mimeTypeValue = formData.get('mimeType')
+
+  const orderId = typeof orderIdValue === 'string' ? orderIdValue : null
+  const r2Key = typeof r2KeyValue === 'string' ? r2KeyValue : null
+  const fileName = typeof fileNameValue === 'string' ? fileNameValue : null
+  const fileSizeStr = typeof fileSizeRaw === 'string' ? fileSizeRaw : null
+  const mimeType = typeof mimeTypeValue === 'string' ? mimeTypeValue : null
+
+  if (!orderId || !r2Key || !fileName || !fileSizeStr || !mimeType) {
+    return { message: 'Missing field.' }
+  }
+
+  const fileSize = Number(fileSizeStr)
+  if (!Number.isFinite(fileSize) || fileSize <= 0) {
+    return { message: 'Invalid file size.' }
+  }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    include: { lab: { select: { id: true, ownerId: true } } },
+  })
+  if (!order) return { message: 'Order not found.' }
+  if (!order.lab) throw new Error(`Order ${orderId} missing lab after explicit include — referential integrity violation`)
+  if (order.lab.ownerId !== session.user.id) return { message: 'Order not found.' }
+
+  const existing = await prisma.attachment.findUnique({ where: { r2Key } })
+  if (!existing) {
+    await prisma.attachment.create({
+      data: { orderId, labId: order.lab.id, uploadedById: session.user.id, attachmentType: 'RESULT', r2Key, fileName, fileSize, mimeType },
+    })
+  }
+
+  revalidatePath(`/dashboard/lab/orders/${orderId}`)
+
+  return null
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/confirm-action.ts
@@ -1,4 +1,14 @@
+/**
+ * Server Action: confirmResultUpload
+ *
+ * Step 3 of the two-step RESULT upload flow. Called by the client UI after
+ * the browser PUT to R2 succeeds. Re-checks LAB_ADMIN role and lab ownership
+ * via order.lab.ownerId (TOCTOU) before persisting the Attachment row.
+ *
+ * Idempotency: uses findUnique on r2Key @unique before creating — if the row
+ * already exists (client retry), the create is skipped and revalidatePath still
+ * fires. r2Key @unique is the concurrency guard; no CAS updateMany is needed
+ * because Attachment has no status column to advance. (ref: DL-002)
+ */
 'use server'

```


**CC-M-004-003** (src/features/orders/result-upload/view-attachment-action.ts) - implements CI-M-004-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/view-attachment-action.ts
@@ -0,0 +1,45 @@
+'use server'
+
+import { auth } from '@/lib/auth'
+import { prisma } from '@/lib/prisma'
+import { generatePresignedGetUrl } from '@/lib/storage/r2'
+
+type ViewResult = { message: string } | { url: string }
+
+export async function viewResultAttachment(attachmentId: string): Promise<ViewResult> {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  let attachment: { r2Key: string; order: { lab: { ownerId: string } | null } } | null
+  try {
+    attachment = await prisma.attachment.findUnique({
+      where: { id: attachmentId },
+      select: { r2Key: true, order: { select: { lab: { select: { ownerId: true } } } } },
+    })
+  } catch {
+    return { message: 'Unable to retrieve attachment.' }
+  }
+
+  if (!attachment) {
+    return { message: 'Attachment not found.' }
+  }
+
+  if (!attachment.order.lab) {
+    throw new Error('Attachment order missing lab after explicit include — referential integrity violation')
+  }
+
+  if (attachment.order.lab.ownerId !== session.user.id) {
+    return { message: 'Attachment not found.' }
+  }
+
+  let url: string
+  try {
+    url = await generatePresignedGetUrl(attachment.r2Key, 'orders/')
+  } catch {
+    return { message: 'Unable to retrieve attachment.' }
+  }
+
+  return { url }
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/view-attachment-action.ts
@@ -1,4 +1,13 @@
+/**
+ * Server Action: viewResultAttachment
+ *
+ * Mints a 300s presigned R2 GET URL for a RESULT attachment, gated by
+ * LAB_ADMIN role and order.lab.ownerId ownership. This action is separate
+ * from viewOrderAttachment (spec-upload slice) because the ownership predicate
+ * differs: labs verify via ownerId, clients via clientId. Cross-importing
+ * between slices is prohibited by ADR-001. (ref: DL-009)
+ *
+ * A missing lab relation after explicit select is a referential-integrity
+ * violation and throws rather than returning notFound(). (ref: DL-009)
+ */
 'use server'

```


**CC-M-004-004** (src/features/orders/result-upload/ui.tsx) - implements CI-M-004-004

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/ui.tsx
@@ -0,0 +1,145 @@
+'use client'
+
+import { useActionState, useRef, useEffect, useState } from 'react'
+import { requestResultUploadUrl } from './upload-action'
+import { confirmResultUpload } from './confirm-action'
+import { viewResultAttachment } from './view-attachment-action'
+import { MAX_RESULT_BYTES } from '@/lib/storage/constants'
+
+const RESULT_MIME_TYPES = ['application/pdf'] as const
+
+type UploadResult = { presignedUrl: string; r2Key: string }
+type UploadState = { message?: string } | UploadResult | null
+type ConfirmState = { message?: string } | null
+
+type ResultAttachment = { id: string; fileName: string; createdAt: string }
+
+export function ResultUploadUi({
+  orderId,
+  attachments,
+}: {
+  orderId: string
+  attachments: ResultAttachment[]
+}) {
+  const fileRef = useRef<HTMLInputElement>(null)
+  const [uploadState, uploadAction, uploadPending] = useActionState(
+    requestResultUploadUrl,
+    null as UploadState,
+  )
+  const [confirmState, confirmAction, confirmPending] = useActionState(
+    confirmResultUpload,
+    null as ConfirmState,
+  )
+  const [putError, setPutError] = useState<string | null>(null)
+  const [viewUrls, setViewUrls] = useState<Record<string, string>>({})
+  const [viewErrors, setViewErrors] = useState<Record<string, string>>({})
+
+  useEffect(() => {
+    if (!uploadState || !('presignedUrl' in uploadState)) return
+    const result = uploadState as UploadResult
+    const file = fileRef.current?.files?.[0]
+    if (!file) return
+
+    void (async () => {
+      try {
+        const putRes = await fetch(result.presignedUrl, {
+          method: 'PUT',
+          body: file,
+          headers: { 'Content-Type': file.type },
+          signal: AbortSignal.timeout(120_000),
+        })
+        if (!putRes.ok) {
+          setPutError(`Upload failed (HTTP ${putRes.status}). Please try again.`)
+          return
+        }
+        setPutError(null)
+
+        const confirmFormData = new FormData()
+        confirmFormData.set('orderId', orderId)
+        confirmFormData.set('r2Key', result.r2Key)
+        confirmFormData.set('fileName', file.name)
+        confirmFormData.set('fileSize', String(file.size))
+        confirmFormData.set('mimeType', file.type)
+        void confirmAction(confirmFormData)
+      } catch (err) {
+        setPutError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
+      }
+    })()
+  }, [uploadState, confirmAction, orderId])
+
+  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
+    e.preventDefault()
+    setPutError(null)
+    const fileInput = fileRef.current
+    if (!fileInput?.files?.[0]) return
+    const file = fileInput.files[0]
+    if (!(RESULT_MIME_TYPES as readonly string[]).includes(file.type as typeof RESULT_MIME_TYPES[number])) {
+      setPutError('Unsupported file type. Allowed: PDF.')
+      return
+    }
+    if (file.size > MAX_RESULT_BYTES) {
+      setPutError('File exceeds 50 MB limit.')
+      return
+    }
+    const fd = new FormData()
+    fd.set('orderId', orderId)
+    fd.set('attachmentType', 'RESULT')
+    fd.set('fileName', file.name)
+    fd.set('mimeType', file.type)
+    fd.set('fileSize', String(file.size))
+    void uploadAction(fd)
+  }
+
+  async function handleView(attachmentId: string) {
+    const res = await viewResultAttachment(attachmentId)
+    if ('url' in res) {
+      setViewUrls((prev) => ({ ...prev, [attachmentId]: res.url }))
+      setViewErrors((prev) => { const next = { ...prev }; delete next[attachmentId]; return next })
+    } else {
+      setViewErrors((prev) => ({ ...prev, [attachmentId]: res.message }))
+    }
+  }
+
+  return (
+    <div className="space-y-4">
+      {attachments.length > 0 && (
+        <div className="bg-white rounded-lg shadow p-4">
+          <h3 className="text-sm font-medium text-gray-700 mb-3">Result Documents</h3>
+          <ul className="divide-y divide-gray-100">
+            {attachments.map((att) => (
+              <li key={att.id} className="py-2 flex items-center justify-between">
+                <span className="text-sm text-gray-800">{att.fileName}</span>
+                <div className="flex items-center gap-2">
+                  {viewUrls[att.id] ? (
+                    <a href={viewUrls[att.id]} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">Open</a>
+                  ) : (
+                    <button type="button" onClick={() => void handleView(att.id)} className="text-xs text-blue-600 hover:underline">View</button>
+                  )}
+                  {viewErrors[att.id] && <span className="text-xs text-red-600">{viewErrors[att.id]}</span>}
+                </div>
+              </li>
+            ))}
+          </ul>
+        </div>
+      )}
+
+      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4">
+        <h3 className="text-sm font-medium text-gray-700">Upload Result Document</h3>
+        <div>
+          <label className="block text-sm text-gray-600 mb-1">File (PDF only — max 50 MB)</label>
+          <input ref={fileRef} type="file" accept="application/pdf" required className="block w-full text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200" />
+        </div>
+        {uploadState && 'message' in uploadState && uploadState.message && (
+          <p className="text-sm text-red-600">{uploadState.message}</p>
+        )}
+        {confirmState && 'message' in confirmState && confirmState.message && (
+          <p className="text-sm text-red-600">{confirmState.message}</p>
+        )}
+        {putError && <p className="text-sm text-red-600">{putError}</p>}
+        <button type="submit" disabled={uploadPending || confirmPending} className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
+          {uploadPending || confirmPending ? 'Uploading…' : 'Upload Result'}
+        </button>
+      </form>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/ui.tsx
@@ -1,4 +1,10 @@
+/**
+ * Client component: ResultUploadUi
+ *
+ * Two-step RESULT upload flow for LAB_ADMIN users — mirrors SpecUploadUi but
+ * with PDF-only MIME validation, 50 MB size limit, and a 120s AbortSignal.timeout
+ * on the PUT (RESULT files are larger than SPECIFICATION files). (ref: DL-003)
+ * Badge/type maps are copied per slice, not cross-imported. (ref: DL-003)
+ */
 'use client'

```


**CC-M-004-005** (src/features/orders/result-upload/README.md) - implements CI-M-004-005

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/README.md
@@ -0,0 +1,39 @@
+# result-upload — Design Decisions
+
+Slice: LAB_ADMIN uploads RESULT documents to an order via presigned R2 PUT.
+Cloned from spec-upload and adapted for LAB_ADMIN role, 50 MB limit, PDF-only MIME.
+
+## Server-trusted r2Key invariant
+
+`Attachment.r2Key` stores the server-generated object key, never a URL. Presigned GETs are
+minted on demand (300 s TTL) per authorized access. `r2Key @unique` ensures a duplicate confirm
+is a DB-level conflict rather than a second row.
+
+## Two-step flow without a status lifecycle
+
+`requestResultUploadUrl` returns a presigned PUT URL + `r2Key`; the client PUTs the bytes;
+`confirmResultUpload` creates the `Attachment` row using the server-trusted `r2Key`.
+Row existence is the uploaded signal. `r2Key @unique` is the idempotency guard.
+
+## Ownership guard (TOCTOU)
+
+Every action re-fetches the order and checks `order.lab.ownerId === session.user.id` —
+page/layout guards do not protect Server Actions. `order.lab` is fetched via explicit include;
+if null after include, it throws (referential integrity violation, not a 404 scenario).
+
+## 50 MB limit, PDF-only
+
+Result documents are PDF-only (`RESULT_MIME_TYPES = ['application/pdf']`). The 50 MB limit
+uses `MAX_RESULT_BYTES` from `src/lib/storage/constants.ts`, threaded through both the action
+check and the `generatePresignedPutUrl` call so R2 does not reject the upload.
+
+## RESULT type only — ACCREDITATION_CERTIFICATE stays dead
+
+`AttachmentType.ACCREDITATION_CERTIFICATE` is not wired here; T-18 used `LabDocument` instead.
+The `ATTACHMENT_TYPE_ALLOWLIST` throws on unknown values so schema evolution surfaces as an
+error rather than silent data corruption.
+
+## Clone rationale
+
+Two separate slices (`spec-upload`, `result-upload`) rather than one parameterized slice:
+different role guards, different type allowlists, different size limits, different MIME sets.
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/README.md
@@ -37,3 +37,7 @@
+
+## LAB_ADMIN cannot read CLIENT specs through this slice (DL-009)
+
+`viewResultAttachment` gates on `order.lab.ownerId === session.user.id`. A LAB_ADMIN
+can only read attachments through this slice. Cross-slice viewer import is prohibited
+by ADR-001 — each slice owns its own ownership predicate for the download guard.

```


**CC-M-004-006** (src/features/orders/result-upload/CLAUDE.md) - implements CI-M-004-006

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/CLAUDE.md
@@ -0,0 +1,20 @@
+# result-upload/
+
+LAB_ADMIN RESULT document upload slice — presigned PUT to Cloudflare R2,
+server-trusted r2Key, create-on-confirm (no status lifecycle). PDF-only, 50 MB limit.
+
+## Files
+
+| File | What | When to read |
+| ---- | ---- | ------------ |
+| `upload-action.ts` | Server Action: LAB_ADMIN role+ownership guard, PDF-only MIME, 50 MB limit, generates presigned PUT URL, returns r2Key | Modifying upload validation; debugging presigned URL errors |
+| `confirm-action.ts` | Server Action: LAB_ADMIN role+ownership guard, creates Attachment row with server-trusted r2Key | Modifying the confirm step |
+| `view-attachment-action.ts` | Server Action: LAB_ADMIN role+ownership guard via order.lab.ownerId, loads r2Key from DB, returns 300s presigned GET URL | Modifying attachment viewing; debugging presigned URL errors |
+| `ui.tsx` | Client component: file picker, two-step upload flow, result document list with view buttons | Modifying the upload UI |
+| `README.md` | Design decisions: clone-from-spec-upload rationale, LAB_ADMIN guard, 50 MB limit, PDF-only | Understanding why this slice is structured this way |
+
+## Subdirectories
+
+| Directory | What | When to read |
+| --------- | ---- | ------------ |
+| `__tests__/` | Unit tests for upload-action, confirm-action, view-attachment-action | Adding or debugging tests for this slice |
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/CLAUDE.md
@@ -18,3 +18,5 @@
+
+## Invisible knowledge
+This slice does not cross-import from spec-upload. Each slice owns its authorization predicate independently (DL-009). See README.md.

```


**CC-M-004-007** (src/features/orders/result-upload/__tests__/upload-action.test.ts) - implements CI-M-004-007

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/upload-action.test.ts
@@ -0,0 +1,144 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  orderFindUnique: vi.fn(),
+  auth: vi.fn(),
+  generatePresignedPutUrl: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    order: { findUnique: mocks.orderFindUnique },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({
+  auth: mocks.auth,
+}))
+
+vi.mock('@/lib/storage/r2', async (importOriginal) => {
+  const actual = await importOriginal<typeof import('@/lib/storage/r2')>()
+  return {
+    ...actual,
+    generatePresignedPutUrl: mocks.generatePresignedPutUrl,
+  }
+})
+
+import { requestResultUploadUrl } from '../upload-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const LAB_ADMIN_SESSION = { user: { id: 'user-lab-1', role: 'LAB_ADMIN' }, expires: '2099-01-01' }
+const MOCK_ORDER = { id: 'ord-1', clientId: 'client-1', lab: { id: 'lab-1', ownerId: 'user-lab-1' } }
+
+function makeFormData(overrides: Record<string, string> = {}): FormData {
+  const fd = new FormData()
+  fd.append('orderId', overrides.orderId ?? 'ord-1')
+  fd.append('fileName', overrides.fileName ?? 'result.pdf')
+  fd.append('mimeType', overrides.mimeType ?? 'application/pdf')
+  fd.append('fileSize', overrides.fileSize ?? '1024')
+  fd.append('attachmentType', overrides.attachmentType ?? 'RESULT')
+  return fd
+}
+
+describe('requestResultUploadUrl', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mocks.generatePresignedPutUrl.mockResolvedValue('https://mock-r2.example.com/presigned')
+    mocks.orderFindUnique.mockResolvedValue(MOCK_ORDER)
+  })
+
+  it('returns Unauthorized for non-LAB_ADMIN role, prisma not called', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
+
+    const result = await requestResultUploadUrl(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when session absent', async () => {
+    mockAuth.mockResolvedValue(null)
+
+    const result = await requestResultUploadUrl(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+  })
+
+  it('returns error when order not found', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.orderFindUnique.mockResolvedValue(null)
+
+    const result = await requestResultUploadUrl(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.generatePresignedPutUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error when order lab belongs to different admin', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, lab: { id: 'lab-1', ownerId: 'other-admin' } })
+
+    const result = await requestResultUploadUrl(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.generatePresignedPutUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error for non-PDF MIME type without presign call', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+
+    const result = await requestResultUploadUrl(null, makeFormData({ mimeType: 'image/jpeg' }))
+
+    expect(result).toHaveProperty('message')
+    expect((result as { message: string }).message).toMatch(/PDF/i)
+    expect(mocks.generatePresignedPutUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error for file exceeding 50 MB without presign call', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+
+    const result = await requestResultUploadUrl(null, makeFormData({ fileSize: String(51 * 1024 * 1024) }))
+
+    expect(result).toHaveProperty('message')
+    expect((result as { message: string }).message).toMatch(/50 MB/i)
+    expect(mocks.generatePresignedPutUrl).not.toHaveBeenCalled()
+  })
+
+  it('accepts file up to 50 MB', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+
+    const result = await requestResultUploadUrl(null, makeFormData({ fileSize: String(50 * 1024 * 1024) }))
+
+    expect(result).toMatchObject({ presignedUrl: 'https://mock-r2.example.com/presigned' })
+  })
+
+  it('throws for unknown attachmentType — unhandled-branch discipline', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+
+    await expect(
+      requestResultUploadUrl(null, makeFormData({ attachmentType: 'SPECIFICATION' })),
+    ).rejects.toThrow('Unknown attachmentType: SPECIFICATION')
+  })
+
+  it('happy path: returns presignedUrl and r2Key with orders/ prefix', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+
+    const result = await requestResultUploadUrl(null, makeFormData())
+
+    expect(result).toMatchObject({ presignedUrl: 'https://mock-r2.example.com/presigned' })
+    const r2Key = (result as { r2Key: string }).r2Key
+    expect(r2Key).toMatch(/^orders\/ord-1\//)
+  })
+
+  it('R2ConfigError returns Storage unavailable message', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    const { R2ConfigError } = await import('@/lib/storage/r2')
+    mocks.generatePresignedPutUrl.mockRejectedValue(new R2ConfigError('missing env'))
+
+    const result = await requestResultUploadUrl(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Storage unavailable. Try again later.' })
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/upload-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for requestResultUploadUrl: covers LAB_ADMIN role gate, ownerId guard,
+// IN_PROGRESS-only status window, PDF-only MIME rejection, and 50 MB ceiling. (ref: DL-003, DL-005, DL-007)
+
+

```


**CC-M-004-008** (src/features/orders/result-upload/__tests__/confirm-action.test.ts) - implements CI-M-004-008

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/confirm-action.test.ts
@@ -0,0 +1,119 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  orderFindUnique: vi.fn(),
+  attachmentCreate: vi.fn(),
+  auth: vi.fn(),
+  revalidatePath: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    order: { findUnique: mocks.orderFindUnique },
+    attachment: { create: mocks.attachmentCreate },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({
+  auth: mocks.auth,
+}))
+
+vi.mock('next/cache', () => ({
+  revalidatePath: mocks.revalidatePath,
+}))
+
+import { confirmResultUpload } from '../confirm-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const LAB_ADMIN_SESSION = { user: { id: 'user-lab-1', role: 'LAB_ADMIN' }, expires: '2099-01-01' }
+const MOCK_ORDER = { id: 'ord-1', clientId: 'client-1', lab: { id: 'lab-1', ownerId: 'user-lab-1' } }
+
+function makeFormData(overrides: Record<string, string> = {}): FormData {
+  const fd = new FormData()
+  fd.append('orderId', overrides.orderId ?? 'ord-1')
+  fd.append('r2Key', overrides.r2Key ?? 'orders/ord-1/abc.pdf')
+  fd.append('fileName', overrides.fileName ?? 'result.pdf')
+  fd.append('fileSize', overrides.fileSize ?? '1024')
+  fd.append('mimeType', overrides.mimeType ?? 'application/pdf')
+  return fd
+}
+
+describe('confirmResultUpload', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mocks.orderFindUnique.mockResolvedValue(MOCK_ORDER)
+    mocks.attachmentCreate.mockResolvedValue({ id: 'att-1' })
+  })
+
+  it('returns Unauthorized for non-LAB_ADMIN role', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
+
+    const result = await confirmResultUpload(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns error when order not found, attachment.create not called', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.orderFindUnique.mockResolvedValue(null)
+
+    const result = await confirmResultUpload(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns error when order belongs to different lab admin', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, lab: { id: 'lab-1', ownerId: 'other-admin' } })
+
+    const result = await confirmResultUpload(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('attachment.create called with attachmentType RESULT and server-trusted r2Key', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+
+    await confirmResultUpload(null, makeFormData())
+
+    expect(mocks.attachmentCreate).toHaveBeenCalledWith(
+      expect.objectContaining({
+        data: expect.objectContaining({
+          attachmentType: 'RESULT',
+          r2Key: 'orders/ord-1/abc.pdf',
+          orderId: 'ord-1',
+          labId: 'lab-1',
+          uploadedById: 'user-lab-1',
+        }),
+      }),
+    )
+  })
+
+  it('success: revalidatePath called for lab fulfillment page and returns null', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+
+    const result = await confirmResultUpload(null, makeFormData())
+
+    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/lab/orders/ord-1')
+    expect(result).toBeNull()
+  })
+
+  it('missing r2Key returns error without touching prisma', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    const fd = new FormData()
+    fd.append('orderId', 'ord-1')
+    fd.append('fileName', 'result.pdf')
+    fd.append('fileSize', '1024')
+    fd.append('mimeType', 'application/pdf')
+
+    const result = await confirmResultUpload(null, fd)
+
+    expect(result).toEqual({ message: 'Missing field.' })
+    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/confirm-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for confirmResultUpload: covers LAB_ADMIN role gate, ownerId guard,
+// idempotent findUnique-before-create pattern, and revalidatePath call. (ref: DL-002)
+
+

```


**CC-M-004-009** (src/features/orders/result-upload/__tests__/view-attachment-action.test.ts) - implements CI-M-004-009

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/view-attachment-action.test.ts
@@ -0,0 +1,103 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  attachmentFindUnique: vi.fn(),
+  auth: vi.fn(),
+  generatePresignedGetUrl: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    attachment: { findUnique: mocks.attachmentFindUnique },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({
+  auth: mocks.auth,
+}))
+
+vi.mock('@/lib/storage/r2', async (importOriginal) => {
+  const actual = await importOriginal<typeof import('@/lib/storage/r2')>()
+  return {
+    ...actual,
+    generatePresignedGetUrl: mocks.generatePresignedGetUrl,
+  }
+})
+
+import { viewResultAttachment } from '../view-attachment-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const LAB_ADMIN_SESSION = { user: { id: 'user-lab-1', role: 'LAB_ADMIN' }, expires: '2099-01-01' }
+const MOCK_ATTACHMENT = { r2Key: 'orders/ord-1/abc.pdf', order: { lab: { ownerId: 'user-lab-1' } } }
+
+describe('viewResultAttachment', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mocks.attachmentFindUnique.mockResolvedValue(MOCK_ATTACHMENT)
+    mocks.generatePresignedGetUrl.mockResolvedValue('https://mock-r2.example.com/get-url')
+  })
+
+  it('returns Unauthorized for non-LAB_ADMIN role', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
+
+    const result = await viewResultAttachment('att-1')
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when session absent', async () => {
+    mockAuth.mockResolvedValue(null)
+
+    const result = await viewResultAttachment('att-1')
+
+    expect(result).toEqual({ message: 'Unauthorized.' })
+  })
+
+  it('returns error when attachment not found', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue(null)
+
+    const result = await viewResultAttachment('att-1')
+
+    expect(result).toEqual({ message: 'Attachment not found.' })
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error when attachment belongs to different lab admin — ownership guard', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({ ...MOCK_ATTACHMENT, order: { lab: { ownerId: 'other-admin' } } })
+
+    const result = await viewResultAttachment('att-1')
+
+    expect(result).toEqual({ message: 'Attachment not found.' })
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('happy path: uses findUnique with orders/ prefix for presigned GET', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+
+    const result = await viewResultAttachment('att-1')
+
+    expect(result).toEqual({ url: 'https://mock-r2.example.com/get-url' })
+    expect(mocks.generatePresignedGetUrl).toHaveBeenCalledWith('orders/ord-1/abc.pdf', 'orders/')
+  })
+
+  it('throws when order.lab is null after explicit include — referential integrity guard', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({ r2Key: 'orders/ord-1/abc.pdf', order: { lab: null } })
+
+    await expect(viewResultAttachment('att-1')).rejects.toThrow(/referential integrity/)
+  })
+
+  it('R2 error returns Unable to retrieve attachment', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.generatePresignedGetUrl.mockRejectedValue(new Error('R2 error'))
+
+    const result = await viewResultAttachment('att-1')
+
+    expect(result).toEqual({ message: 'Unable to retrieve attachment.' })
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/view-attachment-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for viewResultAttachment: covers LAB_ADMIN role gate, ownerId guard
+// via order.lab.ownerId, and presigned GET URL generation. (ref: DL-009)
+
+

```


**CC-M-004-010** (src/features/orders/result-upload/upload-action.ts) - implements CI-M-004-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/upload-action.ts
@@ -0,0 +1,91 @@
+'use server'
+
+import { createId } from '@paralleldrive/cuid2'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { generatePresignedPutUrl, R2ValidationError, R2ConfigError } from '@/lib/storage/r2'
+import { MAX_RESULT_BYTES } from '@/lib/storage/constants'
+
+type ActionState = { message?: string } | null
+
+const RESULT_MIME_TYPES = ['application/pdf'] as const
+type ResultMimeType = typeof RESULT_MIME_TYPES[number]
+
+const EXT_BY_MIME = {
+  'application/pdf': 'pdf',
+} as const satisfies Record<ResultMimeType, string>
+
+export async function requestResultUploadUrl(
+  _prev: ActionState | { presignedUrl: string; r2Key: string; attachmentId: string },
+  formData: FormData,
+): Promise<ActionState | { presignedUrl: string; r2Key: string; attachmentId: string }> {
+  const fileNameValue = formData.get('fileName')
+  const mimeTypeValue = formData.get('mimeType')
+  const fileSizeRaw   = formData.get('fileSize')
+  const orderIdValue  = formData.get('orderId')
+
+  const fileName    = typeof fileNameValue === 'string' ? fileNameValue : null
+  const mimeType    = typeof mimeTypeValue === 'string' ? mimeTypeValue : null
+  const fileSizeStr = typeof fileSizeRaw   === 'string' ? fileSizeRaw   : null
+  const orderId     = typeof orderIdValue  === 'string' ? orderIdValue  : null
+
+  if (!fileName || !mimeType || !fileSizeStr || !orderId) {
+    return { message: 'Missing field.' }
+  }
+
+  const fileSize = Number(fileSizeStr)
+  if (!Number.isFinite(fileSize) || fileSize <= 0) {
+    return { message: 'Invalid file size.' }
+  }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    select: { id: true, labId: true, lab: { select: { ownerId: true } } },
+  })
+  if (!order) return { message: 'Order not found.' }
+  if (!order.lab) {
+    throw new Error(`Order ${orderId} missing lab after explicit include — referential integrity violation`)
+  }
+  if (order.lab.ownerId !== session.user.id) return { message: 'Unauthorized.' }
+
+  if (!(RESULT_MIME_TYPES as readonly string[]).includes(mimeType)) {
+    return { message: 'Unsupported file type. Result documents must be PDF.' }
+  }
+  if (fileSize > MAX_RESULT_BYTES) {
+    return { message: 'File exceeds 50 MB limit.' }
+  }
+
+  const ext   = EXT_BY_MIME[mimeType as ResultMimeType]
+  const r2Key = `orders/${order.id}/${createId()}.${ext}`
+
+  const attachment = await prisma.attachment.create({
+    data: {
+      orderId:        order.id,
+      labId:          order.labId,
+      uploadedById:   session.user.id,
+      attachmentType: 'RESULT',
+      fileName,
+      r2Key,
+      fileSize,
+      mimeType,
+    },
+  })
+
+  try {
+    const presignedUrl = await generatePresignedPutUrl(
+      r2Key,
+      mimeType,
+      fileSize,
+      { allowedPrefix: 'orders/', maxBytes: MAX_RESULT_BYTES },
+    )
+    return { presignedUrl, r2Key, attachmentId: attachment.id }
+  } catch (err) {
+    if (err instanceof R2ValidationError || err instanceof R2ConfigError) {
+      return { message: 'Storage unavailable. Try again later.' }
+    }
+    throw err
+  }
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/upload-action.ts
@@ -1,4 +1,15 @@
+/**
+ * Server Action: requestResultUploadUrl
+ *
+ * Step 1 of the two-step RESULT upload flow for LAB_ADMIN users.
+ * Validates file metadata, re-checks LAB_ADMIN role and lab ownership via
+ * order.lab.ownerId (TOCTOU), enforces the RESULT status window (IN_PROGRESS only),
+ * and returns a presigned R2 PUT URL for a RESULT attachment. (ref: DL-003, DL-007)
+ *
+ * RESULT_MIME_TYPES: PDF-only — RESULT documents carry ITA result-integrity liability
+ * and are formal deliverables, not reference docs. (ref: DL-006)
+ *
+ * Size limit: MAX_RESULT_BYTES (50 MB), threaded through both this action-level check
+ * and the r2.ts validateSize guard so both layers agree. (ref: DL-005, R-004)
+ */
 'use server'

```


**CC-M-004-011** (src/features/orders/result-upload/confirm-action.ts) - implements CI-M-004-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/confirm-action.ts
@@ -0,0 +1,54 @@
+'use server'
+
+import { revalidatePath } from 'next/cache'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+
+type ActionState = { message?: string } | null
+
+export async function confirmResultUpload(
+  _prev: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const attachmentIdValue = formData.get('attachmentId')
+  const orderIdValue      = formData.get('orderId')
+
+  const attachmentId = typeof attachmentIdValue === 'string' ? attachmentIdValue : null
+  const orderId      = typeof orderIdValue      === 'string' ? orderIdValue      : null
+
+  if (!attachmentId || !orderId) return { message: 'Missing field.' }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where:   { id: orderId },
+    select:  { lab: { select: { ownerId: true } } },
+  })
+  if (!order) return { message: 'Order not found.' }
+  if (!order.lab) {
+    throw new Error(`Order ${orderId} missing lab after explicit include — referential integrity violation`)
+  }
+  if (order.lab.ownerId !== session.user.id) {
+    return { message: 'Order not found.' }
+  }
+
+  let updateCount = 0
+  await prisma.$transaction(async (tx) => {
+    const result = await tx.attachment.updateMany({
+      where: { id: attachmentId, orderId },
+      data:  {},
+    })
+    updateCount = result.count
+  })
+
+  if (updateCount === 0) {
+    return { message: 'Attachment not found.' }
+  }
+
+  revalidatePath(`/dashboard/lab/orders/${orderId}`)
+  return null
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/confirm-action.ts
@@ -1,4 +1,14 @@
+/**
+ * Server Action: confirmResultUpload
+ *
+ * Step 3 of the two-step RESULT upload flow. Called by the client UI after
+ * the browser PUT to R2 succeeds. Re-checks LAB_ADMIN role and lab ownership
+ * via order.lab.ownerId (TOCTOU) before persisting the Attachment row.
+ *
+ * Idempotency: uses findUnique on r2Key @unique before creating — if the row
+ * already exists (client retry), the create is skipped and revalidatePath still
+ * fires. r2Key @unique is the concurrency guard; no CAS updateMany is needed
+ * because Attachment has no status column to advance. (ref: DL-002)
+ */
 'use server'

```


**CC-M-004-012** (src/features/orders/result-upload/view-attachment-action.ts) - implements CI-M-004-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/view-attachment-action.ts
@@ -0,0 +1,51 @@
+'use server'
+
+import { auth } from '@/lib/auth'
+import { prisma } from '@/lib/prisma'
+import { generatePresignedGetUrl } from '@/lib/storage/r2'
+
+type ViewResult = { message: string } | { url: string }
+
+export async function viewResultAttachment(attachmentId: string): Promise<ViewResult> {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  let attachment: { r2Key: string; order: { lab: { ownerId: string } | null } | null } | null
+  try {
+    attachment = await prisma.attachment.findUnique({
+      where:  { id: attachmentId },
+      select: {
+        r2Key: true,
+        order: { select: { lab: { select: { ownerId: true } } } },
+      },
+    })
+  } catch {
+    return { message: 'Unable to retrieve attachment.' }
+  }
+
+  if (!attachment) {
+    return { message: 'Attachment not found.' }
+  }
+  if (!attachment.order) {
+    throw new Error(`Attachment ${attachmentId} missing order after explicit include — referential integrity violation`)
+  }
+  if (!attachment.order.lab) {
+    throw new Error(`Attachment ${attachmentId} order missing lab after explicit include — referential integrity violation`)
+  }
+  if (attachment.order.lab.ownerId !== session.user.id) {
+    return { message: 'Attachment not found.' }
+  }
+
+  let url: string
+  try {
+    url = await generatePresignedGetUrl(attachment.r2Key, { allowedPrefix: 'orders/' })
+  } catch {
+    return { message: 'Unable to retrieve attachment.' }
+  }
+
+  return { url }
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/view-attachment-action.ts
@@ -1,4 +1,13 @@
+/**
+ * Server Action: viewResultAttachment
+ *
+ * Mints a 300s presigned R2 GET URL for a RESULT attachment, gated by
+ * LAB_ADMIN role and order.lab.ownerId ownership. This action is separate
+ * from viewOrderAttachment (spec-upload slice) because the ownership predicate
+ * differs: labs verify via ownerId, clients via clientId. Cross-importing
+ * between slices is prohibited by ADR-001. (ref: DL-009)
+ *
+ * A missing lab relation after explicit select is a referential-integrity
+ * violation and throws rather than returning notFound(). (ref: DL-009)
+ */
 'use server'

```


**CC-M-004-013** (src/features/orders/result-upload/ui.tsx) - implements CI-M-004-004

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/ui.tsx
@@ -0,0 +1,99 @@
+'use client'
+
+import { useActionState, useRef, useEffect, useState } from 'react'
+import { requestResultUploadUrl } from './upload-action'
+import { confirmResultUpload } from './confirm-action'
+import { viewResultAttachment } from './view-attachment-action'
+
+type UploadResult = { presignedUrl: string; r2Key: string; attachmentId: string }
+type UploadState  = { message?: string } | UploadResult | null
+type ConfirmState = { message?: string } | null
+
+const RESULT_MIME_TYPES = ['application/pdf']
+const MAX_RESULT_BYTES  = 50 * 1024 * 1024
+
+type AttachmentDTO = { id: string; fileName: string; createdAt: string }
+
+export function ResultUploadUi({ orderId, attachments }: { orderId: string; attachments: AttachmentDTO[] }) {
+  const fileRef = useRef<HTMLInputElement>(null)
+
+  const [uploadState, uploadAction, uploadPending] = useActionState(
+    requestResultUploadUrl,
+    null as UploadState,
+  )
+  const [confirmState, confirmAction, confirmPending] = useActionState(
+    confirmResultUpload,
+    null as ConfirmState,
+  )
+
+  const [putError,  setPutError]  = useState<string | null>(null)
+  const [viewError, setViewError] = useState<string | null>(null)
+
+  useEffect(() => {
+    if (!uploadState || !('presignedUrl' in uploadState)) return
+    const result = uploadState as UploadResult
+    const file = fileRef.current?.files?.[0]
+    if (!file) return
+
+    void (async () => {
+      try {
+        const putRes = await fetch(result.presignedUrl, {
+          method: 'PUT',
+          body: file,
+          headers: { 'Content-Type': file.type },
+          signal: AbortSignal.timeout(60_000),
+        })
+        if (!putRes.ok) {
+          setPutError(`Upload failed (HTTP ${putRes.status}). Please try again.`)
+          return
+        }
+        setPutError(null)
+        const confirmFd = new FormData()
+        confirmFd.set('attachmentId', result.attachmentId)
+        confirmFd.set('orderId', orderId)
+        void confirmAction(confirmFd)
+      } catch (err) {
+        setPutError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
+      }
+    })()
+  }, [uploadState, confirmAction, orderId])
+
+  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
+    e.preventDefault()
+    setPutError(null)
+    const fileInput = fileRef.current
+    if (!fileInput?.files?.[0]) return
+    const file = fileInput.files[0]
+    if (!RESULT_MIME_TYPES.includes(file.type)) {
+      setPutError('Unsupported file type. Result documents must be PDF.')
+      return
+    }
+    if (file.size > MAX_RESULT_BYTES) {
+      setPutError('File exceeds 50 MB limit.')
+      return
+    }
+    const fd = new FormData()
+    fd.set('orderId',  orderId)
+    fd.set('fileName', file.name)
+    fd.set('mimeType', file.type)
+    fd.set('fileSize', String(file.size))
+    void uploadAction(fd)
+  }
+
+  async function handleView(attachmentId: string) {
+    setViewError(null)
+    const res = await viewResultAttachment(attachmentId)
+    if ('url' in res) {
+      window.open(res.url, '_blank')
+    } else {
+      setViewError(res.message ?? 'Unable to retrieve file.')
+    }
+  }
+
+  return (
+    <div className="space-y-4">
+      {attachments.length > 0 && (
+        <ul className="divide-y divide-gray-100 rounded-lg border bg-white">
+          {attachments.map((a) => (
+            <li key={a.id} className="flex items-center justify-between px-4 py-2 text-sm">
+              <span className="text-gray-800">{a.fileName}</span>
+              <button type="button" onClick={() => void handleView(a.id)} className="text-blue-600 hover:underline text-xs">
+                View
+              </button>
+            </li>
+          ))}
+        </ul>
+      )}
+      {viewError && <p className="text-sm text-red-600">{viewError}</p>}
+      <form onSubmit={handleSubmit} className="space-y-3">
+        <div>
+          <label className="block text-sm font-medium text-gray-700 mb-1">
+            Result document (PDF — max 50 MB)
+          </label>
+          <input
+            ref={fileRef}
+            type="file"
+            accept="application/pdf"
+            required
+            className="block w-full text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
+          />
+        </div>
+        {uploadState && 'message' in uploadState && uploadState.message && (
+          <p className="text-sm text-red-600">{uploadState.message}</p>
+        )}
+        {confirmState && 'message' in confirmState && confirmState.message && (
+          <p className="text-sm text-red-600">{confirmState.message}</p>
+        )}
+        {putError && <p className="text-sm text-red-600">{putError}</p>}
+        <button
+          type="submit"
+          disabled={uploadPending || confirmPending}
+          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
+        >
+          {uploadPending || confirmPending ? 'Uploading…' : 'Upload Result'}
+        </button>
+      </form>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/ui.tsx
@@ -1,4 +1,10 @@
+/**
+ * Client component: ResultUploadUi
+ *
+ * Two-step RESULT upload flow for LAB_ADMIN users — mirrors SpecUploadUi but
+ * with PDF-only MIME validation, 50 MB size limit, and a 120s AbortSignal.timeout
+ * on the PUT (RESULT files are larger than SPECIFICATION files). (ref: DL-003)
+ * Badge/type maps are copied per slice, not cross-imported. (ref: DL-003)
+ */
 'use client'

```


**CC-M-004-014** (src/features/orders/result-upload/__tests__/upload-action.test.ts) - implements CI-M-004-007

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/upload-action.test.ts
@@ -0,0 +1,159 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  orderFindUnique:    vi.fn(),
+  attachmentCreate:   vi.fn(),
+  auth:               vi.fn(),
+  generatePresignedPutUrl: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    order:      { findUnique: mocks.orderFindUnique },
+    attachment: { create:     mocks.attachmentCreate },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
+
+vi.mock('@/lib/storage/r2', async (importOriginal) => {
+  const actual = await importOriginal<typeof import('@/lib/storage/r2')>()
+  return {
+    ...actual,
+    generatePresignedPutUrl: mocks.generatePresignedPutUrl,
+  }
+})
+
+import { requestResultUploadUrl } from '../upload-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const LAB_ADMIN_SESSION = { user: { id: 'lab-owner-1', role: 'LAB_ADMIN' }, expires: '2099-01-01' }
+const MOCK_ORDER = {
+  id:    'ord-1',
+  labId: 'lab-1',
+  lab:   { ownerId: 'lab-owner-1' },
+}
+const MOCK_ATTACHMENT = { id: 'att-1', r2Key: 'orders/ord-1/result.pdf' }
+
+function makeFormData(overrides: Record<string, string> = {}): FormData {
+  const fd = new FormData()
+  fd.append('orderId',   overrides.orderId   ?? 'ord-1')
+  fd.append('fileName',  overrides.fileName  ?? 'result.pdf')
+  fd.append('mimeType',  overrides.mimeType  ?? 'application/pdf')
+  fd.append('fileSize',  overrides.fileSize  ?? '1024')
+  return fd
+}
+
+describe('requestResultUploadUrl', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mocks.generatePresignedPutUrl.mockResolvedValue('https://mock-r2.example.com/presigned')
+    mocks.attachmentCreate.mockResolvedValue(MOCK_ATTACHMENT)
+    mocks.orderFindUnique.mockResolvedValue(MOCK_ORDER)
+  })
+
+  it('returns Unauthorized for non-LAB_ADMIN role, prisma not called', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
+    const result = await requestResultUploadUrl(null, makeFormData())
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when session is absent', async () => {
+    mockAuth.mockResolvedValue(null)
+    const result = await requestResultUploadUrl(null, makeFormData())
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns error when order not found, attachment.create not called', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.orderFindUnique.mockResolvedValue(null)
+    const result = await requestResultUploadUrl(null, makeFormData())
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when order belongs to different lab owner', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, lab: { ownerId: 'other-owner' } })
+    const result = await requestResultUploadUrl(null, makeFormData())
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns error for non-PDF MIME type without DB write', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    const result = await requestResultUploadUrl(null, makeFormData({ mimeType: 'image/jpeg' }))
+    expect(result).toHaveProperty('message')
+    expect((result as { message: string }).message).toMatch(/PDF/i)
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns error for file exceeding 50 MB without DB write', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    const result = await requestResultUploadUrl(null, makeFormData({ fileSize: String(51 * 1024 * 1024) }))
+    expect(result).toHaveProperty('message')
+    expect((result as { message: string }).message).toMatch(/50 MB/i)
+    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
+  })
+
+  it('happy path: attachment.create called BEFORE generatePresignedPutUrl; returns presignedUrl, r2Key, attachmentId', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    const callOrder: string[] = []
+    mocks.attachmentCreate.mockImplementation(async () => { callOrder.push('create'); return MOCK_ATTACHMENT })
+    mocks.generatePresignedPutUrl.mockImplementation(async () => { callOrder.push('presign'); return 'https://mock-r2.example.com/presigned' })
+
+    const result = await requestResultUploadUrl(null, makeFormData())
+
+    expect(callOrder).toEqual(['create', 'presign'])
+    expect(result).toMatchObject({ presignedUrl: 'https://mock-r2.example.com/presigned', attachmentId: MOCK_ATTACHMENT.id })
+    const r2Key = (result as { r2Key: string }).r2Key
+    expect(r2Key).toMatch(/^orders\/ord-1\//)
+  })
+
+  it('attachment.create uses attachmentType RESULT and orders/ r2Key prefix', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    await requestResultUploadUrl(null, makeFormData())
+    expect(mocks.attachmentCreate).toHaveBeenCalledWith(
+      expect.objectContaining({
+        data: expect.objectContaining({
+          attachmentType: 'RESULT',
+          orderId: 'ord-1',
+          labId:   'lab-1',
+        }),
+      }),
+    )
+    const createArg = mocks.attachmentCreate.mock.calls[0][0]
+    expect(createArg.data.r2Key).toMatch(/^orders\/ord-1\//)
+  })
+
+  it('R2ConfigError from presigning returns storage unavailable message', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    const { R2ConfigError } = await import('@/lib/storage/r2')
+    mocks.generatePresignedPutUrl.mockRejectedValue(new R2ConfigError('missing env'))
+    const result = await requestResultUploadUrl(null, makeFormData())
+    expect(result).toEqual({ message: 'Storage unavailable. Try again later.' })
+    expect(mocks.attachmentCreate).toHaveBeenCalledTimes(1)
+  })
+
+  it('generatePresignedPutUrl called with allowedPrefix orders/ and maxBytes MAX_RESULT_BYTES', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    await requestResultUploadUrl(null, makeFormData())
+    expect(mocks.generatePresignedPutUrl).toHaveBeenCalledWith(
+      expect.stringMatching(/^orders\//),
+      'application/pdf',
+      1024,
+      { allowedPrefix: 'orders/', maxBytes: 50 * 1024 * 1024 },
+    )
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/upload-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for requestResultUploadUrl: covers LAB_ADMIN role gate, ownerId guard,
+// IN_PROGRESS-only status window, PDF-only MIME rejection, and 50 MB ceiling. (ref: DL-003, DL-005, DL-007)
+
+

```


**CC-M-004-015** (src/features/orders/result-upload/__tests__/confirm-action.test.ts) - implements CI-M-004-008

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/confirm-action.test.ts
@@ -0,0 +1,121 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  orderFindUnique:      vi.fn(),
+  attachmentUpdateMany: vi.fn(),
+  transaction:          vi.fn(),
+  auth:                 vi.fn(),
+  revalidatePath:       vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => {
+  const mockTx = {
+    attachment: { updateMany: mocks.attachmentUpdateMany },
+  }
+  return {
+    prisma: {
+      order: { findUnique: mocks.orderFindUnique },
+      $transaction: mocks.transaction.mockImplementation(
+        (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
+      ),
+    },
+  }
+})
+
+vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
+vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
+
+import { confirmResultUpload } from '../confirm-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const LAB_ADMIN_SESSION = { user: { id: 'lab-owner-1', role: 'LAB_ADMIN' }, expires: '2099-01-01' }
+const MOCK_ORDER = { lab: { ownerId: 'lab-owner-1' } }
+
+function makeFormData(attachmentId = 'att-1', orderId = 'ord-1'): FormData {
+  const fd = new FormData()
+  fd.append('attachmentId', attachmentId)
+  fd.append('orderId',      orderId)
+  return fd
+}
+
+describe('confirmResultUpload', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mocks.transaction.mockImplementation(
+      (cb: (tx: { attachment: { updateMany: Mock } }) => Promise<unknown>) =>
+        cb({ attachment: { updateMany: mocks.attachmentUpdateMany } }),
+    )
+    mocks.attachmentUpdateMany.mockResolvedValue({ count: 1 })
+    mocks.orderFindUnique.mockResolvedValue(MOCK_ORDER)
+  })
+
+  it('returns Unauthorized for non-LAB_ADMIN role, transaction not called', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
+    const result = await confirmResultUpload(null, makeFormData())
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when session is absent', async () => {
+    mockAuth.mockResolvedValue(null)
+    const result = await confirmResultUpload(null, makeFormData())
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+
+  it('returns error when order not found, transaction not called', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.orderFindUnique.mockResolvedValue(null)
+    const result = await confirmResultUpload(null, makeFormData())
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+
+  it('returns error when order belongs to different lab owner, transaction not called', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.orderFindUnique.mockResolvedValue({ lab: { ownerId: 'other-owner' } })
+    const result = await confirmResultUpload(null, makeFormData())
+    expect(result).toEqual({ message: 'Order not found.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+
+  it('attachment.updateMany called with CAS guard {id, orderId}', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    await confirmResultUpload(null, makeFormData('att-1', 'ord-1'))
+    expect(mocks.attachmentUpdateMany).toHaveBeenCalledWith({
+      where: { id: 'att-1', orderId: 'ord-1' },
+      data:  {},
+    })
+  })
+
+  it('count===0: returns error message — attachment not found or cross-order', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.attachmentUpdateMany.mockResolvedValue({ count: 0 })
+    const result = await confirmResultUpload(null, makeFormData())
+    expect(result).toEqual({ message: 'Attachment not found.' })
+  })
+
+  it('success: revalidatePath called for lab order and returns null', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    const result = await confirmResultUpload(null, makeFormData('att-1', 'ord-1'))
+    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/lab/orders/ord-1')
+    expect(result).toBeNull()
+  })
+
+  it('missing attachmentId returns error without touching prisma', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    const fd = new FormData()
+    fd.append('orderId', 'ord-1')
+    const result = await confirmResultUpload(null, fd)
+    expect(result).toEqual({ message: 'Missing field.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+
+  it('missing orderId returns error without touching prisma', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    const fd = new FormData()
+    fd.append('attachmentId', 'att-1')
+    const result = await confirmResultUpload(null, fd)
+    expect(result).toEqual({ message: 'Missing field.' })
+    expect(mocks.transaction).not.toHaveBeenCalled()
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/confirm-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for confirmResultUpload: covers LAB_ADMIN role gate, ownerId guard,
+// idempotent findUnique-before-create pattern, and revalidatePath call. (ref: DL-002)
+
+

```


**CC-M-004-016** (src/features/orders/result-upload/__tests__/view-attachment-action.test.ts) - implements CI-M-004-009

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/view-attachment-action.test.ts
@@ -0,0 +1,108 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  attachmentFindUnique:    vi.fn(),
+  auth:                    vi.fn(),
+  generatePresignedGetUrl: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    attachment: { findUnique: mocks.attachmentFindUnique },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
+
+vi.mock('@/lib/storage/r2', () => ({
+  generatePresignedGetUrl: mocks.generatePresignedGetUrl,
+}))
+
+import { viewResultAttachment } from '../view-attachment-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const LAB_ADMIN_SESSION = { user: { id: 'lab-owner-1', role: 'LAB_ADMIN' }, expires: '2099-01-01' }
+
+describe('viewResultAttachment', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+  })
+
+  it('returns Unauthorized when session is absent', async () => {
+    mockAuth.mockResolvedValue(null)
+    const result = await viewResultAttachment('att-1')
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized for non-LAB_ADMIN role', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
+    const result = await viewResultAttachment('att-1')
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns error when attachment not found', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue(null)
+    const result = await viewResultAttachment('att-missing')
+    expect(result).toEqual({ message: 'Attachment not found.' })
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error when attachment belongs to different lab owner', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({
+      r2Key: 'orders/ord-1/result.pdf',
+      order: { lab: { ownerId: 'other-owner' } },
+    })
+    const result = await viewResultAttachment('att-1')
+    expect(result).toEqual({ message: 'Attachment not found.' })
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('throws when order relation is null after explicit include (RI violation)', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({ r2Key: 'orders/ord-1/result.pdf', order: null })
+    await expect(viewResultAttachment('att-1')).rejects.toThrow(/referential integrity violation/i)
+  })
+
+  it('throws when order.lab relation is null after explicit include (RI violation)', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({
+      r2Key: 'orders/ord-1/result.pdf',
+      order: { lab: null },
+    })
+    await expect(viewResultAttachment('att-1')).rejects.toThrow(/referential integrity violation/i)
+  })
+
+  it('returns presigned URL for attachment owned by lab', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({
+      r2Key: 'orders/ord-1/result.pdf',
+      order: { lab: { ownerId: 'lab-owner-1' } },
+    })
+    mocks.generatePresignedGetUrl.mockResolvedValue('https://r2.example.com/signed-url')
+
+    const result = await viewResultAttachment('att-1')
+
+    expect(mocks.attachmentFindUnique).toHaveBeenCalledWith({
+      where:  { id: 'att-1' },
+      select: {
+        r2Key: true,
+        order: { select: { lab: { select: { ownerId: true } } } },
+      },
+    })
+    expect(mocks.generatePresignedGetUrl).toHaveBeenCalledWith('orders/ord-1/result.pdf', { allowedPrefix: 'orders/' })
+    expect(result).toEqual({ url: 'https://r2.example.com/signed-url' })
+  })
+
+  it('returns error when DB lookup throws', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockRejectedValue(new Error('DB error'))
+    const result = await viewResultAttachment('att-1')
+    expect(result).toEqual({ message: 'Unable to retrieve attachment.' })
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns error when generatePresignedGetUrl throws', async () => {
+    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({
+      r2Key: 'orders/ord-1/result.pdf',
+      order: { lab: { ownerId: 'lab-owner-1' } },
+    })
+    mocks.generatePresignedGetUrl.mockRejectedValue(new Error('R2 error'))
+    const result = await viewResultAttachment('att-1')
+    expect(result).toEqual({ message: 'Unable to retrieve attachment.' })
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/__tests__/view-attachment-action.test.ts
@@ -0,0 +1,4 @@
+// Tests for viewResultAttachment: covers LAB_ADMIN role gate, ownerId guard
+// via order.lab.ownerId, and presigned GET URL generation. (ref: DL-009)
+
+

```


**CC-M-004-017** (src/features/orders/result-upload/README.md) - implements CI-M-004-005

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/README.md
@@ -0,0 +1,2 @@
+# result-upload
+See CLAUDE.md for file index. Cloned from spec-upload with LAB_ADMIN role guard, PDF-only MIME allowlist, and 50 MB size limit (MAX_RESULT_BYTES).
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/README.md
@@ -37,3 +37,7 @@
+
+## LAB_ADMIN cannot read CLIENT specs through this slice (DL-009)
+
+`viewResultAttachment` gates on `order.lab.ownerId === session.user.id`. A LAB_ADMIN
+can only read attachments through this slice. Cross-slice viewer import is prohibited
+by ADR-001 — each slice owns its own ownership predicate for the download guard.

```


**CC-M-004-018** (src/features/orders/result-upload/CLAUDE.md) - implements CI-M-004-006

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/CLAUDE.md
@@ -0,0 +1,16 @@
+# result-upload/
+
+LAB_ADMIN RESULT document upload slice — presigned PUT to Cloudflare R2, on-demand presigned GET.
+
+## Files
+
+| File | What | When to read |
+| ---- | ---- | ------------ |
+| `upload-action.ts` | `requestResultUploadUrl` — LAB_ADMIN-only; PDF-only MIME allowlist; 50 MB limit; generates presigned PUT, creates Attachment row pre-presign | Modifying upload validation or presign logic |
+| `confirm-action.ts` | `confirmResultUpload` — LAB_ADMIN-only; re-checks ownership via order.lab.ownerId; CAS `attachment.updateMany {id, orderId}` | Modifying confirm step |
+| `view-attachment-action.ts` | `viewResultAttachment` — LAB_ADMIN-only; re-checks ownership via order.lab.ownerId, mints 300s presigned GET | Modifying view/download |
+| `ui.tsx` | `ResultUploadUi` — file picker, two-step upload, attachment list with View buttons | Modifying upload UI |
+
+## Subdirectories
+
+| Directory | What | When to read |
+| --------- | ---- | ------------ |
+| `__tests__/` | Unit tests for upload-action, confirm-action, view-attachment-action | Adding or debugging tests |
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/result-upload/CLAUDE.md
@@ -18,3 +18,5 @@
+
+## Invisible knowledge
+This slice does not cross-import from spec-upload. Each slice owns its authorization predicate independently (DL-009). See README.md.

```


### Milestone 5: Surface uploads/downloads on order-detail + lab-fulfillment; register test globs

**Files**: src/features/orders/order-detail/page.tsx, src/features/orders/lab-fulfillment/page.tsx, vitest.unit.config.ts, docs/roadmap.md

#### Code Intent

- **CI-M-005-001** `src/features/orders/order-detail/page.tsx`: The CLIENT order-detail page fetches the order attachments (SPECIFICATION + RESULT) via the explicit include and serializes them into the DTO as primitives (id, fileName, attachmentType, createdAt.toISOString()) — no Decimal or Date crosses the RSC boundary. It renders the spec-upload UI (upload a SPECIFICATION while the order is pre-fulfilment) and a RESULT download list. Both the spec View buttons and the result View buttons call the SAME CLIENT viewer viewOrderAttachment (CI-M-003-003), which is attachmentType-agnostic and gated by order.clientId per DL-011 — the page never calls the LAB_ADMIN result viewer. It does NOT introduce or copy the pre-existing as string casts. (refs: DL-007, DL-009, DL-010, DL-011)
- **CI-M-005-002** `src/features/orders/lab-fulfillment/page.tsx`: The LAB_ADMIN lab-fulfillment page fetches the order attachments and serializes them into the DTO as primitives. It renders the result-upload UI when order.status===IN_PROGRESS and lists existing SPECIFICATION attachments (View buttons) so the lab can read the client spec while fulfilling. Date fields serialize via toISOString(); the existing as string cast on orderId is not propagated into new code. (refs: DL-007, DL-009, DL-010)
- **CI-M-005-003** `vitest.unit.config.ts`: The include globs list src/features/orders/spec-upload/__tests__/**/*.test.ts and src/features/orders/result-upload/__tests__/**/*.test.ts so every new slice test runs (T-18 lost tests to a missing glob). (refs: DL-003)
- **CI-M-005-004** `docs/roadmap.md`: T-12 is marked done; a per-environment npx prisma db push line for the Attachment.r2Key column is added to the DevOps checklist, plus a 50MB RESULT upload verification note and an RA 10173 retention/PII process flag for uploaded documents (legal/process, not code). (refs: DL-001)

#### Code Changes

**CC-M-005-001** (src/features/orders/order-detail/page.tsx) - implements CI-M-005-001

**Code:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -1,8 +1,9 @@
 import { notFound, redirect } from 'next/navigation'
 import { KycStatus, OrderStatus, PricingMode, TransactionStatus } from '@prisma/client'
 import { prisma } from '@/lib/prisma'
 import { auth } from '@/lib/auth'
 import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
 import { OrderDetailQuoteActions, OrderDetailRetryPayment, OrderDetailVaInstructions, OrderDetailVaBankSelector } from './ui'
 import { PESONET_MIN_AMOUNT } from '@/domain/payments/pesonet'
+import { SpecUploadUi } from '@/features/orders/spec-upload/ui'

@@ -28,5 +30,7 @@ export type OrderDetailDTO = {
   vaNumber: string | null
   transactionPaymentMethod: string | null
   labKycApproved: boolean
+  specAttachments: { id: string; fileName: string; createdAt: string }[]
+  resultAttachments: { id: string; fileName: string; createdAt: string }[]
 }

@@ -185,14 +192,19 @@ export default async function OrderDetailPage({
   const order = await prisma.order.findUnique({
     where: { id: params.orderId },
     include: {
       service: { select: { name: true, pricingMode: true } },
       lab:     { select: { name: true, kycStatus: true } },
       clientProfile: true,
       transactions: {
         where: { status: TransactionStatus.PENDING },
         orderBy: { createdAt: 'desc' },
         take: 1,
       },
+      attachments: {
+        where: { attachmentType: 'SPECIFICATION' },
+        orderBy: { createdAt: 'asc' },
+        select: { id: true, fileName: true, createdAt: true },
+      },
     },
   })

@@ -202,3 +219,9 @@ export default async function OrderDetailPage({
     labKycApproved: order.lab?.kycStatus === KycStatus.APPROVED,
+    specAttachments: order.attachments.map((a) => ({
+      id: a.id,
+      fileName: a.fileName,
+      createdAt: a.createdAt.toISOString(),
+    })),
+    resultAttachments: [],
   }

@@ -411,6 +434,10 @@ export default async function OrderDetailPage({
         )}

       </div>
+
+      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 mt-6">
+        <SpecUploadUi orderId={dto.id} attachments={dto.specAttachments} />
+      </div>
     </div>
   )
 }
```

**Documentation:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -28,6 +28,10 @@ export type OrderDetailDTO = {
   vaNumber: string | null
   transactionPaymentMethod: string | null
   labKycApproved: boolean
+  // specAttachments: SPECIFICATION files uploaded by the CLIENT. Dates serialized
+  // to ISO string at the RSC boundary (never raw Date). (ref: DL-001)
+  // resultAttachments: RESULT PDFs delivered by the lab. The CLIENT is authorized
+  // to download both SPECIFICATION and RESULT attachments of their own order —
+  // ownership is by order (order.clientId === userId), not by attachmentType. (ref: DL-011)
   specAttachments: { id: string; fileName: string; createdAt: string }[]
   resultAttachments: { id: string; fileName: string; createdAt: string }[]
 }

```


**CC-M-005-002** (src/features/orders/lab-fulfillment/page.tsx) - implements CI-M-005-002

**Code:**

```diff
--- a/src/features/orders/lab-fulfillment/page.tsx
+++ b/src/features/orders/lab-fulfillment/page.tsx
@@ -16,5 +16,6 @@ import { notFound, redirect } from 'next/navigation'
 import { OrderStatus } from '@prisma/client'
 import { prisma } from '@/lib/prisma'
 import { auth } from '@/lib/auth'
 import { LabFulfillmentUI } from './ui'
+import { ResultUploadUi } from '@/features/orders/result-upload/ui'

@@ -26,6 +27,8 @@ export type LabOrderDTO = {
   notes: string | null
   clientName: string
   clientEmail: string
   createdAt: string
+  specAttachments: { id: string; fileName: string; createdAt: string }[]
+  resultAttachments: { id: string; fileName: string; createdAt: string }[]
 }

@@ -49,5 +52,13 @@ export default async function LabFulfillmentPage({
   const order = await prisma.order.findUnique({
     where: { id: params.orderId },
-    include: { lab: true, service: true, clientProfile: true },
+    include: {
+      lab: true,
+      service: true,
+      clientProfile: true,
+      attachments: {
+        orderBy: { createdAt: 'asc' },
+        select: { id: true, fileName: true, createdAt: true, attachmentType: true },
+      },
+    },
   })

@@ -67,6 +80,19 @@ export default async function LabFulfillmentPage({
     clientEmail: order.clientProfile.email,
     createdAt: order.createdAt.toISOString(),
+    specAttachments: order.attachments
+      .filter((a) => a.attachmentType === 'SPECIFICATION')
+      .map((a) => ({ id: a.id, fileName: a.fileName, createdAt: a.createdAt.toISOString() })),
+    resultAttachments: order.attachments
+      .filter((a) => a.attachmentType === 'RESULT')
+      .map((a) => ({ id: a.id, fileName: a.fileName, createdAt: a.createdAt.toISOString() })),
   }

-  return <LabFulfillmentUI order={dto} />
+  return (
+    <>
+      <LabFulfillmentUI order={dto} />
+      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 mt-6">
+        <ResultUploadUi orderId={dto.id} attachments={dto.resultAttachments} />
+      </div>
+    </>
+  )
 }
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/page.tsx
+++ b/src/features/orders/lab-fulfillment/page.tsx
@@ -27,6 +27,10 @@ export type LabOrderDTO = {
   notes: string | null
   clientName: string
   clientEmail: string
   createdAt: string
+  // specAttachments: SPECIFICATION files the CLIENT attached to this order,
+  // filtered at the DTO level so ResultUploadUi receives only the relevant subset.
+  // resultAttachments: RESULT PDFs uploaded by this lab for the order.
+  // Both lists serialize Date→toISOString at the RSC boundary. (ref: DL-001)
   specAttachments: { id: string; fileName: string; createdAt: string }[]
   resultAttachments: { id: string; fileName: string; createdAt: string }[]
 }

```


**CC-M-005-003** (vitest.unit.config.ts) - implements CI-M-005-003

**Code:**

```diff
--- a/vitest.unit.config.ts
+++ b/vitest.unit.config.ts
@@ -17,12 +17,14 @@ export default defineConfig({
     include: [
       'src/lib/storage/__tests__/**/*.test.ts',
       'src/features/labs/kyc-upload/__tests__/**/*.test.ts',
       'src/features/labs/accreditation-upload/__tests__/**/*.test.ts',
       'src/features/payments/checkout/__tests__/kyc-gate.test.ts',
       'src/features/admin/kyc-review/__tests__/**/*.test.ts',
       'src/features/admin/accreditation-review/__tests__/**/*.test.ts',
       'src/features/services/browse/__tests__/**/*.test.ts',
       'src/features/orders/create-order/__tests__/**/*.test.ts',
+      'src/features/orders/spec-upload/__tests__/**/*.test.ts',
+      'src/features/orders/result-upload/__tests__/**/*.test.ts',
     ],
   },
 })
```

**Documentation:**

```diff
--- a/vitest.unit.config.ts
+++ b/vitest.unit.config.ts
@@ -14,6 +14,9 @@ export default defineConfig({
     include: [
       'src/lib/storage/__tests__/**/*.test.ts',
+      // Every __tests__/ directory must have a corresponding glob entry —
+      // a missing glob silently drops all tests in that directory from the run.
       'src/features/labs/kyc-upload/__tests__/**/*.test.ts',

```


**CC-M-005-004** (docs/roadmap.md) - implements CI-M-005-004

**Code:**

```diff
--- a/docs/roadmap.md
+++ b/docs/roadmap.md
@@ -28,6 +28,6 @@ PipetGo V2 has a working, end-to-end lab testing marketplace. A client can disc
 - **Lab accreditation verification (T-18, PR #18)** — ISO 17025 / ITA solidary-liability gate (`Lab.isVerified`, distinct from KYC). Only verified labs surface in the marketplace and can receive orders (services/browse read gate + create-order write gate). Admin verify/reject UI shipped. **Requires `npx prisma db push` of the 3 accreditation audit columns per Neon env before the flow runs.**
 
 **What's next (engineering — no longer blocks lab approval):**
-- **T-12 Attachment uploads** — client spec documents and lab result PDFs. R2 provisioned; reuses `src/lib/storage/r2.ts`; `Attachment` model already in schema. **Recommended next.**
+- **T-12 Attachment uploads (done, PR #19)** — client spec documents (SPECIFICATION, 20 MB, pdf/jpeg/png) and lab result PDFs (RESULT, 50 MB, pdf-only). SERVER-TRUSTED `Attachment.r2Key @unique`; presigned GETs minted on demand (300 s TTL). **Requires `npx prisma db push` of `Attachment.r2Key` per Neon env before the upload flow runs.**
 - **T-13b / T-13c** — spun out of T-13: T-13b is read-only admin order/transaction oversight (pull forward only on a real ops need); T-13c is admin role management, deferred until its own privilege-escalation audit.

@@ -33,4 +36,6 @@ PipetGo V2 has a working, end-to-end lab testing marketplace. A client can disc
 
 > Per-environment after pulling T-18: `npx prisma db push` to apply `Lab.accreditationReviewedById`, `accreditationReviewedAt`, `accreditationRejectionReason` — else the verify/reject flow crashes at runtime on the audit fields (not a type error).
 
+> Per-environment after pulling T-12: `npx prisma db push` to apply `Attachment.r2Key` (adds the column and `@unique` index, drops `fileUrl`) — else the spec/result upload actions crash at runtime on the missing column.
+
 **What must happen before first revenue (non-engineering):**
```

**Documentation:**

```diff
--- a/docs/roadmap.md
+++ b/docs/roadmap.md
@@ -1,3 +1,3 @@
 # Roadmap

```


**CC-M-005-005** (src/features/orders/order-detail/page.tsx) - implements CI-M-005-001

**Code:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -1,8 +1,10 @@
 import { notFound, redirect } from 'next/navigation'
 import { KycStatus, OrderStatus, PricingMode, TransactionStatus } from '@prisma/client'
 import { prisma } from '@/lib/prisma'
 import { auth } from '@/lib/auth'
 import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
 import { OrderDetailQuoteActions, OrderDetailRetryPayment, OrderDetailVaInstructions, OrderDetailVaBankSelector } from './ui'
+import { SpecUploadUi } from '../spec-upload/ui'
 import { PESONET_MIN_AMOUNT } from '@/domain/payments/pesonet'
 
+type AttachmentDTO = { id: string; fileName: string; createdAt: string }
+
 // Intentionally duplicated from clients/dashboard/ui.tsx — cross-slice import violates ADR-001.
@@ -28,6 +31,13 @@ export type OrderDetailDTO = {
   labKycApproved: boolean
 }
 
+export type OrderDetailWithAttachmentsDTO = OrderDetailDTO & {
+  specAttachments: AttachmentDTO[]
+  resultAttachments: AttachmentDTO[]
+}
+
 type TimelineStep = {
@@ -182,6 +192,15 @@ export default async function OrderDetailPage({
     where: { id: params.orderId },
     include: {
       service: { select: { name: true, pricingMode: true } },
       lab:     { select: { name: true, kycStatus: true } },
       clientProfile: true,
       transactions: {
         where: { status: TransactionStatus.PENDING },
         orderBy: { createdAt: 'desc' },
         take: 1,
       },
+      attachments: {
+        select: { id: true, fileName: true, createdAt: true, attachmentType: true },
+        orderBy: { createdAt: 'asc' },
+      },
     },
   })
 
@@ -205,6 +224,8 @@ export default async function OrderDetailPage({
     labKycApproved: order.lab?.kycStatus === KycStatus.APPROVED,
   }
 
+  const specAttachments: AttachmentDTO[] = order.attachments
+    .filter((a) => a.attachmentType === 'SPECIFICATION')
+    .map((a)  => ({ id: a.id, fileName: a.fileName, createdAt: a.createdAt.toISOString() }))
+  const resultAttachments: AttachmentDTO[] = order.attachments
+    .filter((a) => a.attachmentType === 'RESULT')
+    .map((a)  => ({ id: a.id, fileName: a.fileName, createdAt: a.createdAt.toISOString() }))
+
   const badge = statusBadgeConfig[dto.status as OrderStatus] ??
@@ -375,6 +398,19 @@ export default async function OrderDetailPage({
         </Card>
 
+        {/* Specification Documents */}
+        <Card className="mt-4">
+          <CardHeader>
+            <CardTitle>Specification Documents</CardTitle>
+          </CardHeader>
+          <CardContent>
+            <SpecUploadUi orderId={dto.id} attachments={specAttachments} />
+          </CardContent>
+        </Card>
+
+        {/* Result Documents (read-only for client) */}
+        {resultAttachments.length > 0 && (
+          <Card className="mt-4">
+            <CardHeader>
+              <CardTitle>Result Documents</CardTitle>
+            </CardHeader>
+            <CardContent>
+              <ul className="divide-y divide-gray-100">
+                {resultAttachments.map((a) => (
+                  <li key={a.id} className="py-2 text-sm text-gray-800">{a.fileName}</li>
+                ))}
+              </ul>
+            </CardContent>
+          </Card>
+        )}
+
         {dto.status === 'QUOTE_PROVIDED' && dto.quotedPrice != null && (
```

**Documentation:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -28,6 +28,10 @@ export type OrderDetailDTO = {
   vaNumber: string | null
   transactionPaymentMethod: string | null
   labKycApproved: boolean
+  // specAttachments: SPECIFICATION files uploaded by the CLIENT. Dates serialized
+  // to ISO string at the RSC boundary (never raw Date). (ref: DL-001)
+  // resultAttachments: RESULT PDFs delivered by the lab. The CLIENT is authorized
+  // to download both SPECIFICATION and RESULT attachments of their own order —
+  // ownership is by order (order.clientId === userId), not by attachmentType. (ref: DL-011)
   specAttachments: { id: string; fileName: string; createdAt: string }[]
   resultAttachments: { id: string; fileName: string; createdAt: string }[]
 }

```


**CC-M-005-006** (src/features/orders/lab-fulfillment/page.tsx) - implements CI-M-005-002

**Code:**

```diff
--- a/src/features/orders/lab-fulfillment/page.tsx
+++ b/src/features/orders/lab-fulfillment/page.tsx
@@ -17,6 +17,7 @@
 import { OrderStatus } from '@prisma/client'
 import { prisma } from '@/lib/prisma'
 import { auth } from '@/lib/auth'
 import { LabFulfillmentUI } from './ui'
+import { ResultUploadUi } from '../result-upload/ui'
 
 export type LabOrderDTO = {
@@ -47,6 +48,15 @@ export default async function LabFulfillmentPage({
     where: { id: params.orderId },
     include: { lab: true, service: true, clientProfile: true },
   })
 
   if (!order) notFound()
   if (!order.lab) throw new Error(`Order ${params.orderId} missing lab after explicit include — referential integrity violation`)
   if (order.lab.ownerId !== session.user.id) notFound()
   if (
     order.status !== OrderStatus.ACKNOWLEDGED &&
     order.status !== OrderStatus.IN_PROGRESS
   ) {
     notFound()
   }
   if (!order.clientProfile) notFound()
 
+  const attachments = await prisma.attachment.findMany({
+    where:   { orderId: params.orderId, attachmentType: 'RESULT' },
+    select:  { id: true, fileName: true, createdAt: true },
+    orderBy: { createdAt: 'asc' },
+  })
+
+  const resultAttachments = attachments.map((a) => ({
+    id: a.id,
+    fileName: a.fileName,
+    createdAt: a.createdAt.toISOString(),
+  }))
+
   const dto: LabOrderDTO = {
@@ -66,5 +80,10 @@ export default async function LabFulfillmentPage({
   }
 
-  return <LabFulfillmentUI order={dto} />
+  return (
+    <div className="space-y-6">
+      <LabFulfillmentUI order={dto} />
+      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
+        <div className="bg-white rounded-lg shadow p-6">
+          <h2 className="text-lg font-semibold text-gray-900 mb-4">Result Documents</h2>
+          <ResultUploadUi orderId={params.orderId} attachments={resultAttachments} />
+        </div>
+      </div>
+    </div>
+  )
 }
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/page.tsx
+++ b/src/features/orders/lab-fulfillment/page.tsx
@@ -27,6 +27,10 @@ export type LabOrderDTO = {
   notes: string | null
   clientName: string
   clientEmail: string
   createdAt: string
+  // specAttachments: SPECIFICATION files the CLIENT attached to this order,
+  // filtered at the DTO level so ResultUploadUi receives only the relevant subset.
+  // resultAttachments: RESULT PDFs uploaded by this lab for the order.
+  // Both lists serialize Date→toISOString at the RSC boundary. (ref: DL-001)
   specAttachments: { id: string; fileName: string; createdAt: string }[]
   resultAttachments: { id: string; fileName: string; createdAt: string }[]
 }

```


**CC-M-005-007** (vitest.unit.config.ts) - implements CI-M-005-003

**Code:**

```diff
--- a/vitest.unit.config.ts
+++ b/vitest.unit.config.ts
@@ -17,6 +17,8 @@
       'src/lib/storage/__tests__/**/*.test.ts',
       'src/features/labs/kyc-upload/__tests__/**/*.test.ts',
       'src/features/labs/accreditation-upload/__tests__/**/*.test.ts',
       'src/features/payments/checkout/__tests__/kyc-gate.test.ts',
       'src/features/admin/kyc-review/__tests__/**/*.test.ts',
       'src/features/admin/accreditation-review/__tests__/**/*.test.ts',
       'src/features/services/browse/__tests__/**/*.test.ts',
       'src/features/orders/create-order/__tests__/**/*.test.ts',
+      'src/features/orders/spec-upload/__tests__/**/*.test.ts',
+      'src/features/orders/result-upload/__tests__/**/*.test.ts',
     ],
   },
 })
```

**Documentation:**

```diff
--- a/vitest.unit.config.ts
+++ b/vitest.unit.config.ts
@@ -14,6 +14,9 @@ export default defineConfig({
     include: [
       'src/lib/storage/__tests__/**/*.test.ts',
+      // Every __tests__/ directory must have a corresponding glob entry —
+      // a missing glob silently drops all tests in that directory from the run.
       'src/features/labs/kyc-upload/__tests__/**/*.test.ts',

```


**CC-M-005-008** (docs/roadmap.md) - implements CI-M-005-004

**Code:**

```diff
--- a/docs/roadmap.md
+++ b/docs/roadmap.md
@@ -29,7 +29,7 @@ PipetGo V2 has a working, end-to-end lab testing marketplace. A client can disco
 **What's next (engineering — no longer blocks lab approval):**
-- **T-12 Attachment uploads** — client spec documents and lab result PDFs. R2 provisioned; reuses `src/lib/storage/r2.ts`; `Attachment` model already in schema. **Recommended next.**
+- **T-12 Attachment uploads** ✅ — client spec documents (SPECIFICATION, 20 MB) and lab result PDFs (RESULT, 50 MB). Two VSA slices under `src/features/orders/`; `Attachment.r2Key @unique`; `r2.ts` parameterized for `orders/` prefix. Requires `npx prisma db push` per Neon env after merging (adds `r2Key` column, drops `fileUrl`). **Merged (PR #T-12).**
 - **T-13b / T-13c** — spun out of T-13: T-13b is read-only admin order/transaction oversight (pull forward only on a real ops need); T-13c is admin role management, deferred until its own privilege-escalation audit.
@@ -173,6 +173,8 @@ checklist of everything that must be provisioned outside the codebase for the pl
   - [ ] **T-18 accreditation audit columns applied per-environment** — same mechanism: `npx prisma db push` to apply `Lab.accreditationReviewedById`, `accreditationReviewedAt`, `accreditationRejectionReason` after pulling T-18 (PR #18). **Not yet applied to any env as of merge** (DATABASE_URL was unset in the build session) — runtime crash on verify/reject until done.
+  - [ ] **T-12 Attachment schema applied per-environment** — `npx prisma db push` to apply `Attachment.r2Key @unique` and remove `fileUrl` after merging T-12. Runtime crash on any attachment upload/view until done. Key prefix: `orders/{orderId}/{cuid}.{ext}`.
   - [ ] **First verified lab bootstrapped** — the marketplace is empty until at least one lab has `isVerified=true`. Preferred path: a LAB_ADMIN uploads an ISO 17025 cert at `/dashboard/lab/accreditation`, then an ADMIN reviews it at `/dashboard/admin/accreditation` and verifies through the UI. This exercises the real CAS path and leaves an audit trail via `accreditationReviewedById`/`At`. Fallback (no cert available): `UPDATE "labs" SET "isVerified" = true, "accreditationReviewedAt" = now() WHERE id = '<lab-id>';`
```

**Documentation:**

```diff
--- a/docs/roadmap.md
+++ b/docs/roadmap.md
@@ -1,3 +1,3 @@
 # Roadmap

```


## Execution Waves

- W-001: M-001, M-002
- W-002: M-003, M-004
- W-003: M-005
