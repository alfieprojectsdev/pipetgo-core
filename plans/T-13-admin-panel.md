# Plan

## Overview

T-15 shipped a KYC checkout gate: a lab's first document upload moves Lab.kycStatus PENDING->SUBMITTED, and checkout is blocked until kycStatus===APPROVED. But no path to APPROVED exists — UserRole.ADMIN is defined in the enum yet referenced nowhere, there is no /dashboard/admin route, and r2.ts can presign uploads (PUT) but not downloads (GET), so an admin literally cannot view a submitted KYC document. Labs that have submitted KYC are stuck in SUBMITTED indefinitely and cannot receive payments. This slice builds the ADMIN-gated review surface that lets an admin view a lab's submitted documents and set kycStatus to APPROVED or REJECTED, unblocking the revenue path.

**Approach**: Clone the two established VSA precedents rather than introduce new infrastructure. Authorization mirrors lab-fulfillment's two-layer guard (DL-001): a route-group layout at src/app/dashboard/admin/layout.tsx gates navigation, and every admin Server Action independently re-checks role===ADMIN to close the TOCTOU hole. The kycStatus transition mirrors confirm-action's compare-and-set: updateMany on {id, kycStatus:SUBMITTED} with a count===0 idempotent early-return inside a $transaction that also cascades the lab's UPLOADED documents to VERIFIED/REJECTED and writes the audit columns. Document viewing adds generatePresignedGetUrl to r2.ts (300s TTL, labs/ guard) and mints the URL on click via a dedicated action from the server-trusted LabDocument.r2Key — never from the RSC payload or a client-supplied key. Three nullable audit columns on Lab capture latest-review-only metadata. Role management and order oversight are explicitly out of scope (spun out as T-13b); the first admin is bootstrapped via a documented manual SQL UPDATE.

### Admin KYC review: view document + approve/reject transition

[Diagram pending Technical Writer rendering: DIAG-001]

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Admin authorization is two-layer: a route-group layout guard at src/app/dashboard/admin/layout.tsx plus an independent role===ADMIN re-check inside every admin Server Action. | A layout guard only protects navigation/RSC rendering -> Server Actions are independently invocable via POST regardless of which page rendered -> a missing action-level re-check is a full privilege-escalation hole (TOCTOU), so both layers are mandatory per lab-fulfillment DL-001 precedent. |
| DL-002 | The kycStatus transition uses tx.lab.updateMany({where:{id, kycStatus:SUBMITTED}}) with a count===0 early-return inside the $transaction, never a bare update. | Two admins can open the same SUBMITTED lab and both submit a decision -> a bare update would silently overwrite the first decision with the second -> updateMany with the expected source state in the where clause is a compare-and-set: count===0 means another admin already advanced the state, so the second delivery returns idempotently (confirm-action.ts precedent + CLAUDE.md CAS rule). |
| DL-003 | Only SUBMITTED is an allowed source state; SUBMITTED->APPROVED or SUBMITTED->REJECTED. Any other observed source KycStatus (PENDING/APPROVED/REJECTED) returns a validation error rather than transitioning, and an unhandled target throws. | Approving a PENDING lab (never submitted docs) or re-approving an already-decided lab are contract violations -> silently allowing them would corrupt the KYC audit trail -> constraining the source to SUBMITTED via the CAS where-clause makes the invariant enforceable at the query level, and unhandled enum branches throw per the CLAUDE.md unhandled-states rule. |
| DL-004 | Admin document viewing mints a short-lived (300s) presigned GET URL on click via a dedicated Server Action, generated from the server-trusted LabDocument.r2Key — never embedded in the RSC payload and never built from a client-supplied key. | Embedding a presigned URL in the RSC payload would over-expose the credential for the full page lifetime and leak it into router cache -> minting on click bounds exposure to the 300s TTL and ties each access to a fresh action-level ADMIN re-check -> the key is always looked up server-side from the stored LabDocument row (findUnique on r2Key) so a client cannot request an arbitrary object, and the labs/ prefix guard is reused as defense-in-depth. |
| DL-005 | Review audit metadata (kycReviewedById, kycReviewedAt, kycRejectionReason) lives as three columns directly on the Lab model in a single migration; only the latest review is retained — a re-review overwrites the prior values. | The product requirement is to show the rejection reason back to the lab and record who/when decided -> a separate history table would add a join and migration surface disproportionate to a latest-only requirement -> three nullable columns on Lab satisfy the UX and audit need with one migration, and kycReviewedById is a named relation to User to disambiguate from the existing User.labDocuments back-reference. |
| DL-006 | A rejection requires a non-empty reason: the approve/reject action returns a validation error when decision===REJECTED and the trimmed reason is blank; APPROVED ignores/clears the reason. | A rejection with no reason is shown verbatim to the lab on the kyc-upload page -> a blank reason produces a dead-end UX where the lab cannot know what to fix -> requiring a non-empty reason on reject (validated before the transaction) guarantees actionable feedback, while approve needs no reason so the field is cleared to null on approve. |
| DL-007 | LabDocument rows for the reviewed lab cascade UPLOADED->VERIFIED (on approve) or UPLOADED->REJECTED (on reject) inside the same $transaction as the kycStatus write, via updateMany scoped to {labId, status:UPLOADED}. | Lab.kycStatus and LabDocument.status are two views of the same review outcome -> advancing one without the other leaves the doc list inconsistent with the lab badge -> co-locating both writes in one $transaction makes the outcome atomic, and scoping the doc updateMany to status:UPLOADED avoids clobbering already-VERIFIED/REJECTED docs from a prior review. |
| DL-008 | The first ADMIN user is bootstrapped out-of-band via a documented manual SQL UPDATE (users SET role=ADMIN) recorded in the DevOps checklist; there is no self-service admin-minting UI in this slice. | Granting ADMIN is a privilege-escalation operation -> any in-app minting path is a chicken-and-egg trust hole (who authorizes the first admin?) -> documenting a manual DB UPDATE keeps the trust root out-of-band, consistent with the T-13 playbook pre-session decision; self-service role management is spun out as T-13b. |
| DL-009 | All admin RSC pages serialize Prisma.Decimal via .toFixed(2) and Date via .toISOString() into plain-string DTO fields before crossing to client components; KycStatus/DocumentStatus badge maps use as const satisfies Record<EnumType,…>. | Next.js cannot serialize Decimal or Date across the RSC boundary -> passing them raw is a runtime crash, not a type error -> DTOs type these fields as string and the page converts them, mirroring lab-fulfillment page.tsx; badge maps use satisfies so a new enum member is a compile-time error per the CLAUDE.md enum-dispatch rule, and the map is copied (not imported) to respect VSA slice boundaries. |
| DL-010 | All Prisma lookups on @unique fields (Lab.id, Lab.ownerId, LabDocument.id) use findUnique, never findFirst. | findFirst silently picks an arbitrary row if a uniqueness invariant is ever violated -> that masks data-integrity bugs and produces wrong output in prod -> findUnique enforces the constraint at the query level and makes lookup intent explicit (CLAUDE.md findUnique rule). The detail RSC (CI-M-002-002) and viewKycDocument (CI-M-002-004) both look up by @id, so both use findUnique. |
| DL-011 | The three Lab audit columns are applied per-environment via npx prisma migrate dev; the generated migration file is not committed (prisma/migrations is gitignored), and schema.prisma is the committed source of truth. | prisma/migrations is gitignored in this repo per the T-15 playbook -> committing migration files would diverge from the established workflow, and not applying them per-environment risks a schema/runtime mismatch on a fresh or Neon DB (a runtime crash, not a type error) -> the mitigation is to document the per-environment apply in the DevOps checklist (CI-M-004-004) and require npx prisma generate in M-001 acceptance so missing columns surface at build time in the dependent slice. Mirrors how the T-15 LabDocument migration was handled. |
| DL-012 | The review queue lists labs filtered by kycStatus (default SUBMITTED) ordered by createdAt ascending (oldest submission first). | Labs stuck in SUBMITTED are blocked from revenue -> reviewing oldest-first bounds the worst-case wait for any single lab (FIFO fairness) -> the queue RSC (CI-M-002-001) orders findMany by createdAt asc, matching the SHOULD constraint from the T-13 playbook. |
| DL-013 | The admin reviews one lab at a time: the queue page is list-only (one row per SUBMITTED lab) and a separate detail page shows that lab with per-document presigned-GET View links. This UX shape is the assumed interaction model for the slice (assumption A-4). | An all-in-one table would force every document URL to be minted or embedded up front -> that over-exposes presigned credentials and breaks the on-click TTL-bounded mint (DL-004) -> a queue/detail split lets each presigned-GET mint be scoped to an explicit per-document admin click on the detail page, and keeps the queue payload Decimal/Date-free and credential-free. If the user wants an all-in-one view, the page split is the unit of change. |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| middleware.ts for admin route gating | This repo has no middleware layer; the established pattern is per-page (redirect) and per-action (Unauthorized) guards. Introducing middleware would diverge from lab-fulfillment DL-001 and add a gating surface that does not protect Server Actions anyway (they are independently POST-invocable). Kept the two-layer page+action guard instead. (ref: DL-001) |
| Self-service admin-promotion UI (in-app ADMIN minting) | Granting ADMIN is a privilege-escalation operation; any in-app minting path is a chicken-and-egg trust hole (who authorizes the first admin?). The first admin is bootstrapped out-of-band via documented manual SQL instead; self-service role management is spun out as T-13b. (ref: DL-008) |
| Bundle role-management + order/transaction oversight into this first PR | The privilege-escalation surface of role management needs its own audit and review focus. Keeping the first PR scoped to KYC review only makes it shippable now to unblock the revenue path; role mgmt + order oversight are spun out as T-13b (decided 2026-05-29). (ref: DL-008) |
| Reuse Lab.isVerified for the KYC approval gate | isVerified is the T-18 ISO 17025 accreditation / marketplace-visibility gate, which is distinct from kycStatus payment-gateway verification (T-15 gotcha #3). Conflating them would couple two independent lifecycles; kept kycStatus as the sole gate this slice operates. (ref: DL-003) |
| Bare prisma.lab.update for the kycStatus write | A bare update cannot detect a concurrent review by a second admin and would silently overwrite the first decision. updateMany({where:{id, kycStatus:'SUBMITTED'}}) with a count===0 early-return is the compare-and-set equivalent, required by the CLAUDE.md webhook-CAS rule. (ref: DL-002) |

### Constraints

- MUST: admin route protected by a route-group layout guard at src/app/dashboard/admin/layout.tsx (auth() -> role!=='ADMIN' -> redirect) AND every admin Server Action independently re-checks role==='ADMIN' (TOCTOU — layout guard does not protect actions). Source: lab-fulfillment DL-001. Captured in DL-001 + invariant.
- MUST: kycStatus transition uses updateMany({where:{id, kycStatus:<expected>}}) + count===0 early-return — never bare update. Source: CLAUDE.md webhook CAS rule, confirm-action.ts:25-37. Captured in DL-002 + invariant.
- MUST: allowed source state is SUBMITTED; SUBMITTED -> APPROVED|REJECTED only. Unhandled/unexpected source KycStatus must throw, never default silently. Source: CLAUDE.md unhandled-states rule. Captured in DL-003 + invariant.
- MUST: admin doc viewing uses a server-minted presigned GET URL from server-trusted LabDocument.r2Key — never a client-supplied key. Source: r2.ts:82, storage/README. Captured in DL-004 + invariant.
- MUST: RSC DTOs serialize Decimal via .toFixed(2) and Date via .toISOString() before crossing to any client component. Source: CLAUDE.md RSC-serialization rule, lab-fulfillment page.tsx:67-76. Captured in DL-009 + invariant.
- MUST: findUnique on @unique fields (Lab.ownerId, Lab.id, LabDocument.id) — never findFirst. Source: CLAUDE.md findUnique rule. Captured in DL-010 + invariant.
- MUST: null relation after explicit include throws; missing row / wrong actor -> notFound(). Source: CLAUDE.md, lab-fulfillment page.tsx:54-58. Captured in invariant + CI-M-002-002.
- MUST: redirect() after — never inside — try/catch in Server Actions. Source: CLAUDE.md redirect-after-trycatch rule. Captured in invariant + CI-M-002-003.
- MUST: enum dispatch / badge maps via 'as const satisfies Record<KycStatus|DocumentStatus,…>' — no Record<string,…> + ?? fallback. Source: CLAUDE.md enum-dispatch rule, ui.tsx:10-22. Captured in DL-009 + invariant.
- MUST: prisma/migrations/ is gitignored — apply migration locally (npx prisma migrate dev), do not commit migration files. Source: T-15 playbook note. Captured in DL-011 + invariant + M-001 requirements.
- MUST: first admin is bootstrapped out-of-band (documented manual UPDATE) — no self-service admin minting (chicken-and-egg). Source: T-13 playbook pre-session. Captured in DL-008 + invariant.
- SHOULD: rejection reason captured and shown back to the lab (UX) — audit fields kycReviewedById, kycReviewedAt, kycRejectionReason on Lab. Captured in DL-005, DL-006, M-003.
- SHOULD: cascade LabDocument.status UPLOADED -> VERIFIED|REJECTED in the same $transaction as the kycStatus write. Captured in DL-007.
- SHOULD: review queue lists labs filtered by kycStatus, default SUBMITTED, ordered oldest-submission-first. Captured in DL-012 + CI-M-002-001.

### Known Risks

- **Migration-gitignore drift: prisma/migrations is gitignored, so the three Lab audit columns are applied locally via `npx prisma migrate dev` but the migration file is never committed. A teammate or CI pulling main gets the updated schema.prisma but no migration history, and a fresh/Neon environment will be missing the columns at runtime — a production schema/runtime mismatch, not a type error.**: Document in the DevOps checklist (docs/roadmap.md, CI-M-004-004) that the migration must be applied per-environment with `npx prisma migrate dev` / `prisma db push`, exactly as the T-15 LabDocument migration was handled. Schema.prisma remains the committed source of truth (DL-011); M-001 acceptance requires `npx prisma generate` to expose the new fields so drift surfaces at build time in the slice that depends on them.
- **Concurrent admin review: two admins open the same SUBMITTED lab and both submit a decision; a naive write would let the second silently overwrite the first, corrupting the KYC audit trail (who/when/why).**: The kycStatus write is a compare-and-set: tx.lab.updateMany({where:{id, kycStatus:'SUBMITTED'}}) with a count===0 idempotent early-return inside the $transaction (DL-002). The second delivery observes count===0 ('already reviewed by another admin') and returns without writing, so the first decision and its audit columns stand. Covered by the action.test.ts CAS scenario (CI-M-002-009).

## Invisible Knowledge

### System

Two distinct lab gates exist and must not be conflated: Lab.kycStatus (T-15/T-13, the payment-gateway verification gate this slice operates) versus Lab.isVerified (T-18, ISO 17025 accreditation / marketplace visibility). KYC approval is not accreditation. Authorization is enforced per-page (redirect) and per-action (return Unauthorized) — this repo has no middleware layer, so a layout guard alone protects only navigation; Server Actions are independently POST-invocable and must re-check role themselves. The KYC lifecycle is PENDING -> SUBMITTED (first upload, T-15) -> APPROVED|REJECTED (admin decision, this slice); only SUBMITTED is a valid review source. Manual admin review is the deliberate gate (T-15 DL-018) — Xendit business-verification API submission stays deferred.

### Invariants

- Every admin Server Action re-checks session.user.role===ADMIN before any read or write — the layout guard does not protect actions (TOCTOU).
- kycStatus advances only via updateMany({where:{id, kycStatus:'SUBMITTED'}}) with count===0 early-return — never a bare update; a non-SUBMITTED source is a no-op, not an overwrite.
- An unhandled or unexpected decision value throws / returns a validation error — it never defaults silently to a transition.
- Presigned GET URLs are minted server-side from the stored LabDocument.r2Key, are 300s-lived, pass the labs/ prefix guard, and are never embedded in an RSC payload or built from client input.
- RSC->client DTOs carry no raw Prisma.Decimal or Date; Date is .toISOString(), Decimal is .toFixed(2), typed as string.
- A null relation after an explicit Prisma include throws (referential-integrity violation); a missing row or wrong actor is notFound().
- redirect() is called after — never inside — the try/transaction block in Server Actions.
- Enum badge maps use `as const satisfies Record<EnumType,…>` and are copied into the admin slice, not imported from labs/ (VSA boundary, ADR-001).
- The first ADMIN is minted out-of-band via documented SQL; there is no in-app admin-promotion path in this slice.
- Prisma lookups on @unique fields (Lab.id, Lab.ownerId, LabDocument.id) use findUnique, never findFirst (DL-010, CLAUDE.md findUnique rule).
- The three Lab audit columns are applied per-environment via `npx prisma migrate dev`; the migration file is never committed (prisma/migrations is gitignored); schema.prisma is the committed source of truth and `npx prisma generate` is the build-time drift check (DL-011).
- session.user.id is non-empty wherever it is read: the auth.ts session callback (line 57) throws when the resolved id is missing, so writing session.user.id to the NOT NULL FK kycReviewedById requires no extra null-guard (qa-008).

### Tradeoffs

- Latest-review-only audit (three columns on Lab) chosen over a review-history table: satisfies the show-reason-back-to-lab UX with one migration; full audit history deferred if ever needed.
- On-click presigned GET (extra round-trip per document view) chosen over embedding URLs in the RSC payload: bounds credential exposure to the 300s TTL and ties each access to a fresh ADMIN re-check.
- Manual SQL admin bootstrap chosen over an env allowlist or seed-only path: keeps the privilege-escalation trust root entirely out-of-band; self-service role management is a separate audited surface (T-13b).
- Queue + detail split into two pages (list-only queue, one-lab detail with per-doc view links) chosen over an all-in-one table: keeps each presigned-URL mint scoped to an explicit admin click.

## Milestones

### Milestone 1: Foundation: Lab audit columns + R2 presigned GET URL

**Files**: prisma/schema.prisma, src/lib/storage/r2.ts, src/lib/storage/README.md, src/lib/storage/__tests__/r2.test.ts

**Flags**: error-handling, needs-rationale

**Requirements**:

- Lab model carries kycReviewedById (nullable
- named relation to User)
- kycReviewedAt (nullable DateTime)
- kycRejectionReason (nullable String).|User model carries the inverse relation field for kycReviewedById.|r2.ts exports generatePresignedGetUrl(key) that throws R2ValidationError unless key starts with labs/
- returns a 300s-TTL presigned GET URL
- and is server-only.|Migration applied locally via npx prisma migrate dev; migration files are not committed (prisma/migrations gitignored).

**Acceptance Criteria**:

- npx prisma generate succeeds and Lab type exposes the three audit fields plus kycReviewedBy relation.|generatePresignedGetUrl("foo") throws R2ValidationError; generatePresignedGetUrl("labs/x.pdf") returns a string URL.|r2.test.ts covers the labs/ prefix guard and the 300s expiry on the GET path with the S3 client mocked at the SDK boundary.|npx tsc --noEmit clean.

**Tests**:

- {"files":["src/lib/storage/__tests__/r2.test.ts"]
- "type":"unit"
- "backing":"doc-derived"
- "scenarios":{"normal":["labs/-prefixed key returns a presigned GET URL string"]
- "edge":["expiresIn passed to getSignedUrl is 300"]
- "error":["non-labs/ key throws R2ValidationError"]}}

#### Code Intent

- **CI-M-001-001** `prisma/schema.prisma::model Lab`: Lab carries kycReviewedById String? , kycReviewedAt DateTime? , and kycRejectionReason String? . kycReviewedById relates to User via a named relation (relation name disambiguates from the existing User.labDocuments back-reference). Schema comment notes latest-review-only semantics: re-review overwrites these three fields. (refs: DL-005)
- **CI-M-001-002** `prisma/schema.prisma::model User`: User carries the inverse relation field for the kycReviewedBy named relation (e.g. kycReviewedLabs Lab[] under that relation name) so Prisma can resolve the bidirectional link. (refs: DL-005)
- **CI-M-001-003** `src/lib/storage/r2.ts::generatePresignedGetUrl`: Async function taking a server-trusted key string. Throws R2ValidationError when key does not start with labs/ (reusing the existing prefix guard). Builds the R2 config and S3 client via the existing getR2Config/buildS3Client helpers, then returns getSignedUrl over a GetObjectCommand with expiresIn 300. Module remains server-only (the import server-only at top of the file already enforces this). (refs: DL-004)
- **CI-M-001-004** `src/lib/storage/README.md`: The deferred-GET-URL note is superseded by an entry documenting generatePresignedGetUrl: 300s TTL rationale, labs/ prefix guard reuse, and the server-trusted-key invariant (key always derived from a stored LabDocument.r2Key, never client-supplied). (refs: DL-004)
- **CI-M-001-005** `src/lib/storage/__tests__/r2.test.ts`: Unit coverage for generatePresignedGetUrl mirroring the existing PUT tests: a labs/-prefixed key returns a presigned URL string, a non-labs/ key throws R2ValidationError, and the getSignedUrl call receives expiresIn 300. S3Client and getSignedUrl mocked at the SDK boundary as in the existing suite. (refs: DL-004)

#### Code Changes

**CC-M-001-004** (prisma/schema.prisma) - implements CI-M-001-001

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -151,7 +151,15 @@ model Lab {
   isVerified     Boolean  @default(false)
   kycStatus      KycStatus @default(PENDING)
   createdAt      DateTime @default(now())
   updatedAt      DateTime @updatedAt
+  // Latest-review-only audit — re-review overwrites all three fields.
+  kycReviewedById    String?
+  kycReviewedAt      DateTime?
+  kycRejectionReason String?
 
   owner       User         @relation(fields: [ownerId], references: [id])
+  reviewer    User?        @relation("LabKycReviewer", fields: [kycReviewedById], references: [id])
   services    LabService[]

```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -151,7 +151,7 @@ model Lab {
   kycStatus      KycStatus @default(PENDING)
   createdAt      DateTime @default(now())
   updatedAt      DateTime @updatedAt
-  // Latest-review-only audit — re-review overwrites all three fields.
+  // Latest-review-only audit — re-review overwrites all three fields. (ref: DL-005)
   kycReviewedById    String?
   kycReviewedAt      DateTime?
   kycRejectionReason String?

```


**CC-M-001-005** (prisma/schema.prisma) - implements CI-M-001-002

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -106,6 +106,7 @@ model User {
   accounts    Account[]
   labs        Lab[]
   orders      Order[]
   attachments  Attachment[]
   labDocuments LabDocument[]
+  kycReviewedLabs Lab[] @relation("LabKycReviewer")
 
   @@map("users")

```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -106,6 +106,8 @@ model User {
   labDocuments LabDocument[]
+  // Named relation back-reference for kycReviewedById on Lab. (ref: DL-005)
   kycReviewedLabs Lab[] @relation("LabKycReviewer")

```


**CC-M-001-006** (src/lib/storage/r2.ts) - implements CI-M-001-003

**Code:**

```diff
--- a/src/lib/storage/r2.ts
+++ b/src/lib/storage/r2.ts
@@ -1,6 +1,6 @@ import 'server-only'
 import 'server-only'
-import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
+import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
 import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
 import { ALLOWED_MIME_TYPES, MAX_BYTES } from './constants'
 
@@ -99,3 +99,18 @@ export async function generatePresignedPutUrl(
     { expiresIn: 300 },
   )
 }
+
+export async function generatePresignedGetUrl(
+  key: string,
+): Promise<string> {
+  if (!key.startsWith('labs/')) {
+    throw new R2ValidationError(`Key must start with 'labs/' prefix: ${key}`)
+  }
+
+  const config = getR2Config()
+  const client = buildS3Client(config)
+
+  return getSignedUrl(
+    client,
+    new GetObjectCommand({
+      Bucket: config.bucketName,
+      Key: key,
+    }),
+    { expiresIn: 300 },
+  )
+}
```

**Documentation:**

```diff
--- a/src/lib/storage/r2.ts
+++ b/src/lib/storage/r2.ts
@@ -99,6 +99,13 @@ export async function generatePresignedPutUrl(
 }

+/**
+ * Mints a 300s presigned GET URL for an R2 object.
+ * Key must start with 'labs/' — throws R2ValidationError otherwise (defense-in-depth
+ * against arbitrary-key requests, reusing the same prefix guard as the PUT path).
+ * Call from a Server Action only; the key must be loaded from a stored LabDocument.r2Key,
+ * never from client input. (ref: DL-004)
+ */
 export async function generatePresignedGetUrl(
   key: string,
 ): Promise<string> {

```


**CC-M-001-007** (src/lib/storage/__tests__/r2.test.ts) - implements CI-M-001-005

**Code:**

```diff
--- a/src/lib/storage/__tests__/r2.test.ts
+++ b/src/lib/storage/__tests__/r2.test.ts
@@ -1,7 +1,8 @@
 import { describe, it, expect, vi, beforeEach } from 'vitest'
 
 const mockGetSignedUrl = vi.fn().mockResolvedValue('https://mock-r2.example.com/mock-url')
 
 vi.mock('@aws-sdk/s3-request-presigner', () => ({
   getSignedUrl: mockGetSignedUrl,
 }))
 
 vi.mock('@aws-sdk/client-s3', () => ({
   S3Client: vi.fn().mockImplementation(() => ({})),
   PutObjectCommand: vi.fn().mockImplementation((params) => params),
+  GetObjectCommand: vi.fn().mockImplementation((params) => params),
 }))
 
 describe('r2 storage client', () => {
@@ -61,6 +62,28 @@ describe('r2 storage client', () => {
   it('module exports generatePresignedPutUrl but NOT generatePresignedGetUrl', async () => {
     const r2Module = await import('@/lib/storage/r2')
     expect(typeof r2Module.generatePresignedPutUrl).toBe('function')
-    expect((r2Module as Record<string, unknown>)['generatePresignedGetUrl']).toBeUndefined()
+    expect(typeof (r2Module as Record<string, unknown>)['generatePresignedGetUrl']).toBe('function')
   })
 
   it('module exports ALLOWED_MIME_TYPES and MAX_BYTES', async () => {
@@ -68,4 +71,25 @@ describe('r2 storage client', () => {
     expect(ALLOWED_MIME_TYPES).toContain('application/pdf')
     expect(MAX_BYTES).toBe(20 * 1024 * 1024)
   })
+
+  describe('generatePresignedGetUrl', () => {
+    it('returns a presigned GET URL for a labs/-prefixed key', async () => {
+      const { generatePresignedGetUrl } = await import('@/lib/storage/r2')
+      const url = await generatePresignedGetUrl('labs/L1/doc.pdf')
+      expect(url).toBe('https://mock-r2.example.com/mock-url')
+      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1)
+      const [, cmd, opts] = mockGetSignedUrl.mock.calls[0]
+      expect(cmd).toMatchObject({ Key: 'labs/L1/doc.pdf' })
+      expect(opts).toMatchObject({ expiresIn: 300 })
+    })
+
+    it('throws R2ValidationError for a key without labs/ prefix', async () => {
+      const { generatePresignedGetUrl, R2ValidationError } = await import('@/lib/storage/r2')
+      await expect(
+        generatePresignedGetUrl('uploads/x.pdf'),
+      ).rejects.toBeInstanceOf(R2ValidationError)
+      expect(mockGetSignedUrl).not.toHaveBeenCalled()
+    })
+
+    it('passes expiresIn 300 to getSignedUrl', async () => {
+      const { generatePresignedGetUrl } = await import('@/lib/storage/r2')
+      await generatePresignedGetUrl('labs/L1/doc.pdf')
+      const [, , opts] = mockGetSignedUrl.mock.calls[0]
+      expect(opts.expiresIn).toBe(300)
+    })
+  })
 })
```

**Documentation:**

```diff
--- a/src/lib/storage/__tests__/r2.test.ts
+++ b/src/lib/storage/__tests__/r2.test.ts
@@ -61,6 +61,8 @@ describe('r2 storage client', () => {
-  it('module exports generatePresignedPutUrl but NOT generatePresignedGetUrl', async () => {
+  it('module exports generatePresignedPutUrl AND generatePresignedGetUrl', async () => {
+    // Both presign functions are exported: generatePresignedPutUrl for lab uploads,
+    // generatePresignedGetUrl for admin document viewing. The test validates both
+    // are present so a future removal of either fails loudly here.
     const r2Module = await import('@/lib/storage/r2')

```


**CC-M-001-008** (src/lib/storage/README.md) - implements CI-M-001-004

**Code:**

```diff
--- a/src/lib/storage/README.md
+++ b/src/lib/storage/README.md
@@ -9,4 +9,6 @@ ## Architecture
 `r2.ts` exposes `generatePresignedPutUrl(key, contentType, contentLength)`. The Server Action calls this function, returns the URL to the client, and the client PUTs the file directly to R2. The signed URL binds `Content-Type` so R2 rejects uploads whose actual header does not match the signed value — a second validation layer after the server-side allowlist check.
 
+`r2.ts` also exposes `generatePresignedGetUrl(key)`. A Server Action calls this on admin click to mint a 300s-TTL signed URL for a specific R2 object. The key is always derived server-side from the stored `LabDocument.r2Key` — it is never client-supplied. See DL-004 in `src/features/admin/kyc-review/README.md`.
+
 R2 credentials never leave the server. The client receives only the short-lived presigned URL.
 
@@ -32,3 +34,3 @@ ## Invariants
 - Keys must start with `labs/`. `R2ValidationError` is thrown for any other prefix.
 - Allowed MIME types: `application/pdf`, `image/jpeg`, `image/png`. Max size: 20 MB (`20 * 1024 * 1024` bytes).
-- `generatePresignedGetUrl` does not exist in this module. Add it only when a concrete caller requires it.
+- `generatePresignedGetUrl(key)`: throws `R2ValidationError` unless `key` starts with `labs/`; returns a 300 s presigned GET URL. The key is always server-trusted (looked up from a stored `LabDocument.r2Key`, never from client input). TTL rationale: 300 s bounds the credential exposure window while being sufficient for a single admin click-to-view.

```

**Documentation:**

```diff
--- a/src/lib/storage/README.md
+++ b/src/lib/storage/README.md
@@ -9,5 +9,7 @@ ## Architecture
 `r2.ts` exposes `generatePresignedPutUrl(key, contentType, contentLength)`. The Server Action calls this function, returns the URL to the client, and the client PUTs the file directly to R2. The signed URL binds `Content-Type` so R2 rejects uploads whose actual header does not match the signed value — a second validation layer after the server-side allowlist check.

+`r2.ts` also exposes `generatePresignedGetUrl(key)`. A Server Action calls this on admin click to mint a 300s-TTL signed URL for a specific R2 object. The key is always derived server-side from the stored `LabDocument.r2Key` — it is never client-supplied. See DL-004 in `src/features/admin/kyc-review/README.md`.
+
 R2 credentials never leave the server. The client receives only the short-lived presigned URL.

```


### Milestone 2: Admin KYC review slice: queue, detail+doc-view, approve/reject action

**Files**: src/features/admin/kyc-review/page.tsx, src/features/admin/kyc-review/detail-page.tsx, src/features/admin/kyc-review/action.ts, src/features/admin/kyc-review/view-document-action.ts, src/features/admin/kyc-review/ui.tsx, src/features/admin/kyc-review/detail-ui.tsx, src/features/admin/kyc-review/CLAUDE.md, src/features/admin/kyc-review/README.md, src/features/admin/kyc-review/__tests__/action.test.ts, src/features/admin/kyc-review/__tests__/view-document-action.test.ts

**Flags**: error-handling, needs-rationale, security

**Requirements**:

- Queue RSC lists labs filtered by kycStatus (default SUBMITTED)
- ordered oldest createdAt first
- each row linking to the detail page; ADMIN-only via redirect.|Detail RSC loads one lab by id with documents included
- splits guards (no lab -> notFound; null relation after include -> throw; non-ADMIN -> redirect)
- and serializes a Decimal/Date-free DTO.|approveOrReject Server Action re-checks role===ADMIN
- validates a non-empty reason on REJECTED
- and runs a $transaction: lab.updateMany CAS on {id
- kycStatus:SUBMITTED} with count===0 early-return
- then LabDocument updateMany {labId
- status:UPLOADED} -> VERIFIED|REJECTED
- writing kycReviewedById/kycReviewedAt and kycRejectionReason (null on approve); redirect after the try/transaction.|viewDocument Server Action re-checks role===ADMIN
- findUnique LabDocument by id
- derives r2Key server-side
- mints a 300s presigned GET URL
- returns it for client-side window.open.|Badge maps for KycStatus and DocumentStatus use as const satisfies Record<EnumType
- …>
- copied into this slice (not imported from labs/).

**Acceptance Criteria**:

- Non-ADMIN session hitting either page redirects to /auth/signin; non-ADMIN invoking either action returns Unauthorized.|Approving a SUBMITTED lab sets kycStatus=APPROVED
- kycReviewedById/At
- clears rejectionReason
- and flips its UPLOADED docs to VERIFIED in one transaction.|Rejecting with a blank reason returns a validation error and writes nothing; rejecting with a reason sets REJECTED + reason and flips UPLOADED docs to REJECTED.|Concurrent second decision on the same lab (kycStatus already advanced) hits count===0 and returns idempotently without overwriting.|viewDocument returns a labs/-scoped presigned URL only for an existing LabDocument; tsc + vitest clean.

**Tests**:

- {"files":["src/features/admin/kyc-review/__tests__/action.test.ts"
- "src/features/admin/kyc-review/__tests__/view-document-action.test.ts"]
- "type":"unit"
- "backing":"doc-derived"
- "scenarios":{"normal":["approve SUBMITTED lab -> APPROVED + docs VERIFIED"
- "reject with reason -> REJECTED + docs REJECTED + reason stored"]
- "edge":["CAS count===0 (already reviewed) returns without write"
- "approve clears prior rejectionReason to null"]
- "error":["non-ADMIN session returns Unauthorized"
- "REJECTED with blank reason returns validation error
- no write"
- "viewDocument for missing LabDocument id surfaces an error"]}}

#### Code Intent

- **CI-M-002-001** `src/features/admin/kyc-review/page.tsx::AdminKycQueuePage`: Async RSC. Calls auth(); when no session or session.user.role!==ADMIN, redirect to /auth/signin. Reads the queue: prisma.lab.findMany filtered by kycStatus (default SUBMITTED), ordered createdAt asc (oldest submission first), selecting only fields the list needs (id, name, kycStatus, createdAt) plus owner email. Maps each row to a queue DTO whose Date fields are .toISOString() strings — no Decimal/Date crosses the boundary. Renders the queue UI with a link per row to /dashboard/admin/kyc/[labId]. (refs: DL-001, DL-009)
- **CI-M-002-002** `src/features/admin/kyc-review/detail-page.tsx::AdminKycDetailPage`: Async RSC taking { params: { labId } }. auth() gate: non-ADMIN redirect to /auth/signin. prisma.lab.findUnique by id with documents included (ordered createdAt desc) and owner selected. Split guards: !lab -> notFound(); !lab.owner -> throw new Error referential-integrity violation after explicit include. Builds a Decimal/Date-free LabKycDetailDTO: lab id/name/kycStatus, owner name+email, kycRejectionReason (string|null), kycReviewedAt (.toISOString()|null), and a documents array each with id, documentType, fileName, mimeType, status, createdAt (.toISOString()). Renders detail UI; the r2Key is NOT included in the DTO (viewing goes through the action). (refs: DL-001, DL-004, DL-009)
- **CI-M-002-003** `src/features/admin/kyc-review/action.ts::approveOrRejectKyc`: Server Action (use server) with signature (prevState, formData). Reads labId and decision (APPROVED|REJECTED) and reason from formData. Validates: labId present; decision is exactly APPROVED or REJECTED else validation error (unhandled target throws/returns error, never silent default); when decision===REJECTED the trimmed reason must be non-empty else return a validation error and write nothing; on APPROVED reason resolves to null. Re-checks auth(): no session or role!==ADMIN -> return Unauthorized. session.user.id is guaranteed non-empty here: the auth.ts session callback (line 57) throws if the resolved id is missing, so writing session.user.id to the non-null FK kycReviewedById needs no extra null-guard (documented because kycReviewedById is a NOT NULL relation column). Runs prisma.$transaction: tx.lab.updateMany({where:{id:labId, kycStatus:SUBMITTED}, data:{kycStatus:decision, kycReviewedById:session.user.id, kycReviewedAt:new Date(), kycRejectionReason: decision===REJECTED ? reason : null}}); if count===0 return inside the tx (idempotent — another admin already decided). Then tx.labDocument.updateMany({where:{labId, status:UPLOADED}, data:{status: decision===APPROVED ? VERIFIED : REJECTED}}). After the transaction resolves (never inside it), revalidate the relevant paths and redirect back to /dashboard/admin/kyc — redirect placed after the try/transaction per the redirect-after-trycatch rule. (refs: DL-002, DL-003, DL-005, DL-006, DL-007)
- **CI-M-002-004** `src/features/admin/kyc-review/view-document-action.ts::viewKycDocument`: Server Action (use server) taking a labDocumentId. Re-checks auth(): non-ADMIN -> return an error/Unauthorized state. prisma.labDocument.findUnique by id (id is @id); if absent throw or return error (missing row after explicit lookup). Derives r2Key from the stored row (server-trusted, never from client input) and calls generatePresignedGetUrl(doc.r2Key) which enforces the labs/ guard. Returns { url } for the client to window.open; the URL is short-lived (300s) and is never embedded in any RSC payload. (refs: DL-001, DL-004)
- **CI-M-002-005** `src/features/admin/kyc-review/ui.tsx::AdminKycQueueUi`: use client component rendering the queue list from the queue DTO: lab name, owner email, KycStatus badge, submitted-at, and a link to each detail page. KycStatus badge map declared locally as const satisfies Record<KycStatus,{label;className}> — copied, not imported from labs/, per VSA. (refs: DL-009)
- **CI-M-002-006** `src/features/admin/kyc-review/detail-ui.tsx::AdminKycDetailUi`: use client component for one lab: shows lab/owner identity, KycStatus + DocumentStatus badges (both maps declared locally as const satisfies Record<EnumType,…>), the document list with a View-document button per row that invokes viewKycDocument via useActionState/transition and window.open(url) on success, an Approve form and a Reject form (Reject includes a required reason textarea) wired to approveOrRejectKyc with useActionState, surfacing validation messages. Prior kycRejectionReason/kycReviewedAt shown when present. (refs: DL-004, DL-006, DL-009)
- **CI-M-002-007** `src/features/admin/kyc-review/CLAUDE.md`: Slice navigation doc: file table (page, detail-page, action, view-document-action, ui, detail-ui) with what/when-to-read, mirroring the kyc-upload CLAUDE.md format. (refs: DL-001)
- **CI-M-002-008** `src/features/admin/kyc-review/README.md`: Invisible-knowledge doc: two-layer auth rationale (layout guard + action re-check, TOCTOU), the kycStatus-vs-isVerified distinction (KYC payment gate != ISO 17025 accreditation), CAS-on-SUBMITTED transition rationale, on-click presigned-GET rationale (TTL, server-trusted key), and latest-review-only audit semantics. (refs: DL-001, DL-002, DL-003, DL-004, DL-005)
- **CI-M-002-009** `src/features/admin/kyc-review/__tests__/action.test.ts`: Vitest unit suite using vi.hoisted full Prisma mock with method names aligned exactly to the handler calls (lab.updateMany, labDocument.updateMany, $transaction). Scenarios: non-ADMIN -> Unauthorized, no write; approve SUBMITTED -> kycStatus APPROVED, kycReviewedById/At set, rejectionReason null, docs VERIFIED; reject with reason -> REJECTED + reason + docs REJECTED; reject with blank/whitespace reason -> validation error, no write; CAS count===0 -> early-return, no doc write; invalid decision value -> validation error. (refs: DL-002, DL-003, DL-006, DL-007)
- **CI-M-002-010** `src/features/admin/kyc-review/__tests__/view-document-action.test.ts`: Vitest unit suite: non-ADMIN -> Unauthorized; existing LabDocument -> calls generatePresignedGetUrl with the stored r2Key and returns its url; missing LabDocument id -> error. generatePresignedGetUrl and prisma mocked; assert the key passed is the server-fetched r2Key, never a client value. (refs: DL-001, DL-004)

#### Code Changes

**CC-M-002-001** (src/features/admin/kyc-review/page.tsx) - implements CI-M-002-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/kyc-review/page.tsx
@@ -0,0 +1,54 @@
+import { redirect } from 'next/navigation'
+import { type KycStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { AdminKycQueueUi } from './ui'
+
+export type LabQueueDTO = {
+  id: string
+  name: string
+  kycStatus: KycStatus
+  ownerEmail: string
+  createdAt: string
+}
+
+export default async function AdminKycQueuePage() {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  const labs = await prisma.lab.findMany({
+    where: { kycStatus: 'SUBMITTED' },
+    orderBy: { createdAt: 'asc' },
+    select: {
+      id: true,
+      name: true,
+      kycStatus: true,
+      createdAt: true,
+      owner: { select: { email: true } },
+    },
+  })
+
+  const queue: LabQueueDTO[] = labs.map((lab) => ({
+    id: lab.id,
+    name: lab.name,
+    kycStatus: lab.kycStatus,
+    ownerEmail: lab.owner.email,
+    createdAt: lab.createdAt.toISOString(),
+  }))
+
+  return <AdminKycQueueUi labs={queue} />
+}
```

**Documentation:**

```diff
--- a/src/features/admin/kyc-review/page.tsx
+++ b/src/features/admin/kyc-review/page.tsx
@@ -1,3 +1,8 @@
+/**
+ * Admin KYC review queue RSC.
+ * Lists labs with kycStatus=SUBMITTED ordered by Lab.createdAt asc (lab creation order,
+ * used as a proxy for queue age — FIFO bounds worst-case wait for revenue-blocked labs). (ref: DL-012)
+ * Role check duplicated from layout.tsx: Server Actions and RSCs are independently
+ * invocable; the layout guard does not protect them. (ref: DL-001)
+ */
 import { redirect } from 'next/navigation'
 import { type KycStatus } from '@prisma/client'

```


**CC-M-002-002** (src/features/admin/kyc-review/detail-page.tsx) - implements CI-M-002-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/kyc-review/detail-page.tsx
@@ -0,0 +1,68 @@
+import { notFound, redirect } from 'next/navigation'
+import { type KycStatus, type DocumentStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { AdminKycDetailUi } from './detail-ui'
+
+export type LabDocumentDTO = {
+  id: string
+  documentType: string
+  fileName: string
+  mimeType: string
+  status: DocumentStatus
+  createdAt: string
+}
+
+export type LabKycDetailDTO = {
+  id: string
+  name: string
+  kycStatus: KycStatus
+  ownerName: string | null
+  ownerEmail: string
+  kycRejectionReason: string | null
+  kycReviewedAt: string | null
+  documents: LabDocumentDTO[]
+}
+
+export default async function AdminKycDetailPage({
+  params,
+}: {
+  params: { labId: string }
+}) {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  const lab = await prisma.lab.findUnique({
+    where: { id: params.labId },
+    include: {
+      owner: true,
+      documents: { orderBy: { createdAt: 'desc' } },
+    },
+  })
+
+  if (!lab) notFound()
+  if (!lab.owner)
+    throw new Error(
+      `Lab ${params.labId} missing owner after explicit include — referential integrity violation`,
+    )
+
+  const dto: LabKycDetailDTO = {
+    id: lab.id,
+    name: lab.name,
+    kycStatus: lab.kycStatus,
+    ownerName: lab.owner.name ?? null,
+    ownerEmail: lab.owner.email,
+    kycRejectionReason: lab.kycRejectionReason ?? null,
+    kycReviewedAt: lab.kycReviewedAt ? lab.kycReviewedAt.toISOString() : null,
+    documents: lab.documents.map((doc) => ({
+      id: doc.id,
+      documentType: doc.documentType,
+      fileName: doc.fileName,
+      mimeType: doc.mimeType,
+      status: doc.status,
+      createdAt: doc.createdAt.toISOString(),
+    })),
+  }
+
+  return <AdminKycDetailUi dto={dto} />
+}
```

**Documentation:**

```diff
--- a/src/features/admin/kyc-review/detail-page.tsx
+++ b/src/features/admin/kyc-review/detail-page.tsx
@@ -1,3 +1,9 @@
+/**
+ * Admin KYC detail RSC for a single lab.
+ * LabKycDetailDTO carries all Date fields as .toISOString() strings and no
+ * Prisma.Decimal fields — Next.js cannot serialize those types across the RSC
+ * boundary. (ref: DL-009)
+ * A null owner after an explicit include is a referential-integrity violation, not a
+ * missing-row scenario, and throws rather than calling notFound(). (ref: DL-010)
+ */
 import { notFound, redirect } from 'next/navigation'
 import { type KycStatus, type DocumentStatus } from '@prisma/client'

```


**CC-M-002-003** (src/features/admin/kyc-review/action.ts) - implements CI-M-002-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/kyc-review/action.ts
@@ -0,0 +1,77 @@
+'use server'
+
+import { revalidatePath } from 'next/cache'
+import { redirect } from 'next/navigation'
+import { KycStatus, DocumentStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+
+type ActionState = { message?: string } | null
+
+export async function approveOrRejectKyc(
+  _prevState: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const labId = formData.get('labId') as string | null
+  if (!labId) return { message: 'Missing labId.' }
+
+  const decision = formData.get('decision') as string | null
+  if (decision !== KycStatus.APPROVED && decision !== KycStatus.REJECTED) {
+    return { message: 'Invalid decision value.' }
+  }
+
+  const reason = (formData.get('reason') as string | null)?.trim() ?? ''
+  if (decision === KycStatus.REJECTED && reason === '') {
+    return { message: 'A rejection reason is required.' }
+  }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  // session.user.id is guaranteed non-empty: auth.ts session callback throws
+  // when token.sub is missing, so kycReviewedById (NOT NULL FK) is safe to write.
+  const reviewerId = session.user.id
+
+  let shouldRedirect = false
+
+  const result = await prisma.$transaction(async (tx) => {
+    const labResult = await tx.lab.updateMany({
+      where: { id: labId, kycStatus: KycStatus.SUBMITTED },
+      data: {
+        kycStatus: decision,
+        kycReviewedById: reviewerId,
+        kycReviewedAt: new Date(),
+        kycRejectionReason: decision === KycStatus.REJECTED ? reason : null,
+      },
+    })
+
+    if (labResult.count === 0) {
+      return { message: 'Lab is no longer in SUBMITTED state — review may have already been recorded.' }
+    }
+
+    const docStatus =
+      decision === KycStatus.APPROVED ? DocumentStatus.VERIFIED : DocumentStatus.REJECTED
+
+    await tx.labDocument.updateMany({
+      where: { labId, status: DocumentStatus.UPLOADED },
+      data: { status: docStatus },
+    })
+
+    shouldRedirect = true
+    return null
+  })
+
+  if (result !== null) return result
+
+  revalidatePath('/dashboard/admin/kyc')
+  revalidatePath(`/dashboard/admin/kyc/${labId}`)
+
+  if (shouldRedirect) {
+    redirect('/dashboard/admin/kyc')
+  }
+
+  return null
+}
```

**Documentation:**

```diff
--- a/src/features/admin/kyc-review/action.ts
+++ b/src/features/admin/kyc-review/action.ts
@@ -9,6 +9,27 @@ import { auth } from '@/lib/auth'
 type ActionState = { message?: string } | null

+/**
+ * Approves or rejects a lab's KYC submission.
+ *
+ * Authorization: role===ADMIN re-checked here independently of the layout guard —
+ * Server Actions are POST-invocable without navigating through any page, so the
+ * layout guard does not protect them (TOCTOU). (ref: DL-001)
+ *
+ * State transition: uses tx.lab.updateMany({where:{id, kycStatus:SUBMITTED}}) with a
+ * count===0 early-return. Two admins reviewing the same lab concurrently: the second
+ * write observes count===0 and returns without overwriting the first decision. A bare
+ * update() would silently clobber the first decision. (ref: DL-002)
+ *
+ * Source state: only SUBMITTED is valid. PENDING/APPROVED/REJECTED source returns a
+ * validation error — unhandled states never default silently. (ref: DL-003)
+ *
+ * Rejection reason: required when decision===REJECTED; cleared to null on APPROVED.
+ * The reason is shown back to the lab on the kyc-upload page. (ref: DL-006)
+ *
+ * Document cascade: UPLOADED documents for this lab are advanced to VERIFIED or REJECTED
+ * in the same $transaction as the kycStatus write, so both states are atomic. (ref: DL-007)
+ *
+ * redirect() is called after — never inside — the transaction block. (CLAUDE.md)
+ */
 export async function approveOrRejectKyc(

```


**CC-M-002-004** (src/features/admin/kyc-review/view-document-action.ts) - implements CI-M-002-004

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/kyc-review/view-document-action.ts
@@ -0,0 +1,28 @@
+'use server'
+
+import { auth } from '@/lib/auth'
+import { prisma } from '@/lib/prisma'
+import { generatePresignedGetUrl } from '@/lib/storage/r2'
+
+type ViewDocumentState = { url?: string; message?: string } | null
+
+export async function viewKycDocument(
+  labDocumentId: string,
+): Promise<ViewDocumentState> {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const doc = await prisma.labDocument.findUnique({
+    where: { id: labDocumentId },
+    select: { r2Key: true },
+  })
+
+  if (!doc) return { message: 'Document not found.' }
+
+  const url = await generatePresignedGetUrl(doc.r2Key)
+
+  return { url }
+}
```

**Documentation:**

```diff
--- a/src/features/admin/kyc-review/view-document-action.ts
+++ b/src/features/admin/kyc-review/view-document-action.ts
@@ -4,6 +4,16 @@ import { auth } from '@/lib/auth'
 import { prisma } from '@/lib/prisma'
 import { generatePresignedGetUrl } from '@/lib/storage/r2'

+/**
+ * Mints a 300s presigned GET URL for a single KYC document on admin click.
+ *
+ * The URL is not embedded in the RSC payload. It is minted on demand so that each
+ * access is tied to a fresh ADMIN re-check and the credential is bounded to the
+ * 300s TTL rather than the full page lifetime. (ref: DL-004)
+ *
+ * The R2 key is loaded from the stored LabDocument row (findUnique on @unique id) —
+ * it is never derived from client input. generatePresignedGetUrl enforces the labs/
+ * prefix guard as defense-in-depth. (ref: DL-004, DL-010)
+ */
 export async function viewKycDocument(

```


**CC-M-002-005** (src/features/admin/kyc-review/ui.tsx) - implements CI-M-002-005

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/kyc-review/ui.tsx
@@ -0,0 +1,50 @@
+'use client'
+
+import Link from 'next/link'
+import { type KycStatus } from '@prisma/client'
+import type { LabQueueDTO } from './page'
+
+const KYC_STATUS_BADGE = {
+  PENDING:   { label: 'Not started',    className: 'bg-gray-200 text-gray-700' },
+  SUBMITTED: { label: 'Pending review', className: 'bg-yellow-200 text-yellow-800' },
+  APPROVED:  { label: 'Approved',       className: 'bg-green-200 text-green-800' },
+  REJECTED:  { label: 'Rejected',       className: 'bg-red-200 text-red-700' },
+} as const satisfies Record<KycStatus, { label: string; className: string }>
+
+export function AdminKycQueueUi({ labs }: { labs: LabQueueDTO[] }) {
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
+        <h1 className="text-2xl font-bold text-gray-900 mb-6">KYC Review Queue</h1>
+        {labs.length === 0 ? (
+          <p className="text-gray-500">No labs pending KYC review.</p>
+        ) : (
+          <div className="bg-white rounded-lg shadow overflow-hidden">
+            <table className="min-w-full divide-y divide-gray-200">
+              <thead className="bg-gray-50">
+                <tr>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Lab</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Owner</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Submitted</th>
+                  <th className="px-6 py-3" />
+                </tr>
+              </thead>
+              <tbody className="bg-white divide-y divide-gray-200">
+                {labs.map((lab) => {
+                  const badge = KYC_STATUS_BADGE[lab.kycStatus]
+                  return (
+                    <tr key={lab.id}>
+                      <td className="px-6 py-4 text-sm font-medium text-gray-900">{lab.name}</td>
+                      <td className="px-6 py-4 text-sm text-gray-500">{lab.ownerEmail}</td>
+                      <td className="px-6 py-4">
+                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
+                          {badge.label}
+                        </span>
+                      </td>
+                      <td className="px-6 py-4 text-sm text-gray-500">{new Date(lab.createdAt).toLocaleDateString()}</td>
+                      <td className="px-6 py-4 text-right">
+                        <Link href={`/dashboard/admin/kyc/${lab.id}`} className="text-sm font-medium text-blue-600 hover:text-blue-500">
+                          Review
+                        </Link>
+                      </td>
+                    </tr>
+                  )
+                })}
+              </tbody>
+            </table>
+          </div>
+        )}
+      </div>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/admin/kyc-review/ui.tsx
+++ b/src/features/admin/kyc-review/ui.tsx
@@ -6,6 +6,9 @@ import type { LabQueueDTO } from './page'

+// KYC_STATUS_BADGE is copied from labs/kyc-upload/ui.tsx rather than imported.
+// VSA (ADR-001) prohibits cross-slice UI imports. `satisfies Record<KycStatus,…>`
+// makes a missing enum member a compile-time error. (ref: DL-009)
 const KYC_STATUS_BADGE = {

```


**CC-M-002-006** (src/features/admin/kyc-review/detail-ui.tsx) - implements CI-M-002-006

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/kyc-review/detail-ui.tsx
@@ -0,0 +1,134 @@
+'use client'
+
+import { useActionState, useTransition } from 'react'
+import { type KycStatus, type DocumentStatus } from '@prisma/client'
+import { approveOrRejectKyc } from './action'
+import { viewKycDocument } from './view-document-action'
+import type { LabKycDetailDTO } from './detail-page'
+
+const KYC_STATUS_BADGE = {
+  PENDING:   { label: 'Not started',    className: 'bg-gray-200 text-gray-700' },
+  SUBMITTED: { label: 'Pending review', className: 'bg-yellow-200 text-yellow-800' },
+  APPROVED:  { label: 'Approved',       className: 'bg-green-200 text-green-800' },
+  REJECTED:  { label: 'Rejected',       className: 'bg-red-200 text-red-700' },
+} as const satisfies Record<KycStatus, { label: string; className: string }>
+
+const DOC_STATUS_BADGE = {
+  PENDING:  { label: 'Pending upload', className: 'bg-gray-100 text-gray-600' },
+  UPLOADED: { label: 'Uploaded',       className: 'bg-blue-100 text-blue-700' },
+  VERIFIED: { label: 'Verified',       className: 'bg-green-100 text-green-700' },
+  REJECTED: { label: 'Rejected',       className: 'bg-red-100 text-red-700' },
+} as const satisfies Record<DocumentStatus, { label: string; className: string }>
+
+function ViewDocumentButton({ docId }: { docId: string }) {
+  const [isPending, startTransition] = useTransition()
+
+  function handleClick() {
+    startTransition(async () => {
+      const result = await viewKycDocument(docId)
+      if (result?.url) {
+        window.open(result.url, '_blank', 'noopener,noreferrer')
+      }
+    })
+  }
+
+  return (
+    <button
+      onClick={handleClick}
+      disabled={isPending}
+      className="text-sm font-medium text-blue-600 hover:text-blue-500 disabled:opacity-50"
+    >
+      {isPending ? 'Loading…' : 'View'}
+    </button>
+  )
+}
+
+export function AdminKycDetailUi({ dto }: { dto: LabKycDetailDTO }) {
+  const kycBadge = KYC_STATUS_BADGE[dto.kycStatus]
+
+  const [approveState, approveAction, approvePending] = useActionState(
+    approveOrRejectKyc,
+    null,
+  )
+  const [rejectState, rejectAction, rejectPending] = useActionState(
+    approveOrRejectKyc,
+    null,
+  )
+
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
+        <div className="bg-white rounded-lg shadow p-6">
+          <h1 className="text-xl font-bold text-gray-900 mb-1">{dto.name}</h1>
+          <p className="text-sm text-gray-500">{dto.ownerName ?? dto.ownerEmail} · {dto.ownerEmail}</p>
+          <div className="mt-3">
+            <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${kycBadge.className}`}>
+              {kycBadge.label}
+            </span>
+          </div>
+          {dto.kycRejectionReason && (
+            <p className="mt-3 text-sm text-red-700">Last rejection reason: {dto.kycRejectionReason}</p>
+          )}
+          {dto.kycReviewedAt && (
+            <p className="mt-1 text-xs text-gray-400">Reviewed: {new Date(dto.kycReviewedAt).toLocaleString()}</p>
+          )}
+        </div>
+
+        <div className="bg-white rounded-lg shadow p-6">
+          <h2 className="text-sm font-medium text-gray-700 mb-3">Documents</h2>
+          {dto.documents.length === 0 ? (
+            <p className="text-sm text-gray-500">No documents submitted.</p>
+          ) : (
+            <ul className="divide-y divide-gray-100">
+              {dto.documents.map((doc) => {
+                const db = DOC_STATUS_BADGE[doc.status]
+                return (
+                  <li key={doc.id} className="py-3 flex items-center justify-between gap-4">
+                    <div>
+                      <p className="text-sm font-medium text-gray-900">{doc.fileName}</p>
+                      <p className="text-xs text-gray-400">{doc.documentType} · {doc.mimeType}</p>
+                    </div>
+                    <div className="flex items-center gap-3">
+                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${db.className}`}>
+                        {db.label}
+                      </span>
+                      <ViewDocumentButton docId={doc.id} />
+                    </div>
+                  </li>
+                )
+              })}
+            </ul>
+          )}
+        </div>
+
+        {dto.kycStatus === 'SUBMITTED' && (
+          <div className="grid grid-cols-2 gap-4">
+            <form action={approveAction}>
+              <input type="hidden" name="labId" value={dto.id} />
+              <input type="hidden" name="decision" value="APPROVED" />
+              {approveState?.message && (
+                <p className="mb-2 text-sm text-red-600">{approveState.message}</p>
+              )}
+              <button
+                type="submit"
+                disabled={approvePending || rejectPending}
+                className="w-full rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
+              >
+                {approvePending ? 'Approving…' : 'Approve'}
+              </button>
+            </form>
+
+            <form action={rejectAction} className="space-y-2">
+              <input type="hidden" name="labId" value={dto.id} />
+              <input type="hidden" name="decision" value="REJECTED" />
+              <textarea
+                name="reason"
+                required
+                placeholder="Rejection reason (required)"
+                rows={3}
+                className="w-full border rounded-md px-3 py-2 text-sm resize-none"
+              />
+              {rejectState?.message && (
+                <p className="text-sm text-red-600">{rejectState.message}</p>
+              )}
+              <button
+                type="submit"
+                disabled={approvePending || rejectPending}
+                className="w-full rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
+              >
+                {rejectPending ? 'Rejecting…' : 'Reject'}
+              </button>
+            </form>
+          </div>
+        )}
+      </div>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/admin/kyc-review/detail-ui.tsx
+++ b/src/features/admin/kyc-review/detail-ui.tsx
@@ -24,6 +24,11 @@ const DOC_STATUS_BADGE = {
 } as const satisfies Record<DocumentStatus, { label: string; className: string }>

+/**
+ * Mints a presigned GET URL on click via viewKycDocument and opens it in a new tab.
+ * URL is not pre-fetched or stored in component state — each click triggers a fresh
+ * Server Action call that re-checks ADMIN role and binds a new 300s TTL. (ref: DL-004)
+ */
 function ViewDocumentButton({ docId }: { docId: string }) {

```


**CC-M-002-007** (src/features/admin/kyc-review/__tests__/action.test.ts) - implements CI-M-002-009

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/kyc-review/__tests__/action.test.ts
@@ -0,0 +1,137 @@
+import { describe, it, expect, vi, beforeEach } from 'vitest'
+
+const mockLabUpdateMany = vi.fn()
+const mockLabDocumentUpdateMany = vi.fn()
+const mockTransaction = vi.fn()
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    $transaction: mockTransaction,
+  },
+}))
+
+const mockAuth = vi.fn()
+vi.mock('@/lib/auth', () => ({ auth: mockAuth }))
+
+vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
+vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
+
+function makeFormData(fields: Record<string, string>): FormData {
+  const fd = new FormData()
+  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
+  return fd
+}
+
+function makeAdminSession(id = 'admin-1') {
+  return { user: { id, role: 'ADMIN' } }
+}
+
+describe('approveOrRejectKyc', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
+      fn({ lab: { updateMany: mockLabUpdateMany }, labDocument: { updateMany: mockLabDocumentUpdateMany } }),
+    )
+  })
+
+  it('returns Unauthorized when session is absent', async () => {
+    mockAuth.mockResolvedValue(null)
+    const { approveOrRejectKyc } = await import('../action')
+    const result = await approveOrRejectKyc(null, makeFormData({ labId: 'lab-1', decision: 'APPROVED' }))
+    expect(result).toMatchObject({ message: 'Unauthorized.' })
+    expect(mockTransaction).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized for non-ADMIN role', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' } })
+    const { approveOrRejectKyc } = await import('../action')
+    const result = await approveOrRejectKyc(null, makeFormData({ labId: 'lab-1', decision: 'APPROVED' }))
+    expect(result).toMatchObject({ message: 'Unauthorized.' })
+    expect(mockTransaction).not.toHaveBeenCalled()
+  })
+
+  it('returns validation error for invalid decision value', async () => {
+    mockAuth.mockResolvedValue(makeAdminSession())
+    const { approveOrRejectKyc } = await import('../action')
+    const result = await approveOrRejectKyc(null, makeFormData({ labId: 'lab-1', decision: 'PENDING' }))
+    expect(result).toMatchObject({ message: 'Invalid decision value.' })
+    expect(mockTransaction).not.toHaveBeenCalled()
+  })
+
+  it('returns validation error when REJECTED with blank reason', async () => {
+    mockAuth.mockResolvedValue(makeAdminSession())
+    const { approveOrRejectKyc } = await import('../action')
+    const result = await approveOrRejectKyc(
+      null,
+      makeFormData({ labId: 'lab-1', decision: 'REJECTED', reason: '   ' }),
+    )
+    expect(result).toMatchObject({ message: 'A rejection reason is required.' })
+    expect(mockTransaction).not.toHaveBeenCalled()
+  })
+
+  it('approves a SUBMITTED lab: writes APPROVED + audit fields + clears reason', async () => {
+    mockAuth.mockResolvedValue(makeAdminSession('admin-1'))
+    mockLabUpdateMany.mockResolvedValue({ count: 1 })
+    mockLabDocumentUpdateMany.mockResolvedValue({ count: 2 })
+    const { approveOrRejectKyc } = await import('../action')
+    const result = await approveOrRejectKyc(
+      null,
+      makeFormData({ labId: 'lab-1', decision: 'APPROVED' }),
+    )
+    expect(result).toBeNull()
+    expect(mockLabUpdateMany).toHaveBeenCalledWith(
+      expect.objectContaining({
+        where: { id: 'lab-1', kycStatus: 'SUBMITTED' },
+        data: expect.objectContaining({
+          kycStatus: 'APPROVED',
+          kycReviewedById: 'admin-1',
+          kycRejectionReason: null,
+        }),
+      }),
+    )
+    expect(mockLabDocumentUpdateMany).toHaveBeenCalledWith({
+      where: { labId: 'lab-1', status: 'UPLOADED' },
+      data: { status: 'VERIFIED' },
+    })
+  })
+
+  it('rejects a SUBMITTED lab: writes REJECTED + reason + flips docs REJECTED', async () => {
+    mockAuth.mockResolvedValue(makeAdminSession('admin-1'))
+    mockLabUpdateMany.mockResolvedValue({ count: 1 })
+    mockLabDocumentUpdateMany.mockResolvedValue({ count: 1 })
+    const { approveOrRejectKyc } = await import('../action')
+    const result = await approveOrRejectKyc(
+      null,
+      makeFormData({ labId: 'lab-1', decision: 'REJECTED', reason: 'Missing BIR 2303' }),
+    )
+    expect(result).toBeNull()
+    expect(mockLabUpdateMany).toHaveBeenCalledWith(
+      expect.objectContaining({
+        where: { id: 'lab-1', kycStatus: 'SUBMITTED' },
+        data: expect.objectContaining({
+          kycStatus: 'REJECTED',
+          kycRejectionReason: 'Missing BIR 2303',
+        }),
+      }),
+    )
+    expect(mockLabDocumentUpdateMany).toHaveBeenCalledWith({
+      where: { labId: 'lab-1', status: 'UPLOADED' },
+      data: { status: 'REJECTED' },
+    })
+  })
+
+  it('returns idempotent message when lab not in SUBMITTED (CAS count===0)', async () => {
+    mockAuth.mockResolvedValue(makeAdminSession())
+    mockLabUpdateMany.mockResolvedValue({ count: 0 })
+    const { approveOrRejectKyc } = await import('../action')
+    const result = await approveOrRejectKyc(
+      null,
+      makeFormData({ labId: 'lab-1', decision: 'APPROVED' }),
+    )
+    expect(result).toMatchObject({ message: expect.stringContaining('no longer in SUBMITTED') })
+    expect(mockLabDocumentUpdateMany).not.toHaveBeenCalled()
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/admin/kyc-review/__tests__/action.test.ts
+++ b/src/features/admin/kyc-review/__tests__/action.test.ts
@@ -1,3 +1,6 @@
+// Unit tests for approveOrRejectKyc.
+// Covers: auth guard, input validation, CAS count===0 no-op, approve/reject happy paths,
+// document cascade, and concurrent-review idempotency scenario. (ref: DL-002, DL-003)
 import { describe, it, expect, vi, beforeEach } from 'vitest'

```


**CC-M-002-008** (src/features/admin/kyc-review/__tests__/view-document-action.test.ts) - implements CI-M-002-010

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/kyc-review/__tests__/view-document-action.test.ts
@@ -0,0 +1,67 @@
+import { describe, it, expect, vi, beforeEach } from 'vitest'
+
+const mockFindUnique = vi.fn()
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    labDocument: { findUnique: mockFindUnique },
+  },
+}))
+
+const mockAuth = vi.fn()
+vi.mock('@/lib/auth', () => ({ auth: mockAuth }))
+
+const mockGeneratePresignedGetUrl = vi.fn()
+vi.mock('@/lib/storage/r2', () => ({
+  generatePresignedGetUrl: mockGeneratePresignedGetUrl,
+}))
+
+function makeAdminSession(id = 'admin-1') {
+  return { user: { id, role: 'ADMIN' } }
+}
+
+describe('viewKycDocument', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+  })
+
+  it('returns Unauthorized when session is absent', async () => {
+    mockAuth.mockResolvedValue(null)
+    const { viewKycDocument } = await import('../view-document-action')
+    const result = await viewKycDocument('doc-1')
+    expect(result).toMatchObject({ message: 'Unauthorized.' })
+    expect(mockFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized for non-ADMIN role', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' } })
+    const { viewKycDocument } = await import('../view-document-action')
+    const result = await viewKycDocument('doc-1')
+    expect(result).toMatchObject({ message: 'Unauthorized.' })
+    expect(mockFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns error when document is not found', async () => {
+    mockAuth.mockResolvedValue(makeAdminSession())
+    mockFindUnique.mockResolvedValue(null)
+    const { viewKycDocument } = await import('../view-document-action')
+    const result = await viewKycDocument('doc-missing')
+    expect(result).toMatchObject({ message: 'Document not found.' })
+    expect(mockGeneratePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns a presigned URL for an existing document using the server-fetched r2Key', async () => {
+    mockAuth.mockResolvedValue(makeAdminSession())
+    mockFindUnique.mockResolvedValue({ r2Key: 'labs/L1/doc.pdf' })
+    mockGeneratePresignedGetUrl.mockResolvedValue('https://r2.example.com/signed')
+    const { viewKycDocument } = await import('../view-document-action')
+    const result = await viewKycDocument('doc-1')
+    expect(result).toMatchObject({ url: 'https://r2.example.com/signed' })
+    expect(mockGeneratePresignedGetUrl).toHaveBeenCalledWith('labs/L1/doc.pdf')
+  })
+
+  it('passes the server-fetched r2Key to generatePresignedGetUrl — never a client value', async () => {
+    mockAuth.mockResolvedValue(makeAdminSession())
+    const storedKey = 'labs/L1/contract.pdf'
+    mockFindUnique.mockResolvedValue({ r2Key: storedKey })
+    mockGeneratePresignedGetUrl.mockResolvedValue('https://r2.example.com/signed')
+    const { viewKycDocument } = await import('../view-document-action')
+    await viewKycDocument('doc-1')
+    const [keyArg] = mockGeneratePresignedGetUrl.mock.calls[0]
+    expect(keyArg).toBe(storedKey)
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/admin/kyc-review/__tests__/view-document-action.test.ts
+++ b/src/features/admin/kyc-review/__tests__/view-document-action.test.ts
@@ -1,3 +1,6 @@
+// Unit tests for viewKycDocument.
+// Covers: auth guard, missing-document path, and presigned-URL return path.
+// Key is loaded from the stored row; client cannot supply an arbitrary key. (ref: DL-004)
 import { describe, it, expect, vi, beforeEach } from 'vitest'

```


**CC-M-002-009** (src/features/admin/kyc-review/CLAUDE.md) - implements CI-M-002-007

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/kyc-review/CLAUDE.md
@@ -0,0 +1,20 @@
+# src/features/admin/kyc-review
+
+Admin KYC review slice. ADMIN role only.
+
+## Files
+
+| File | What | When to read |
+| ---- | ---- | ------------ |
+| `page.tsx` | Queue RSC — lists SUBMITTED labs oldest-first | Adding queue columns or filters |
+| `detail-page.tsx` | Detail RSC — one lab + documents; Decimal/Date DTO | Changing detail data shape |
+| `action.ts` | `approveOrRejectKyc` Server Action — CAS updateMany, doc cascade | Changing decision logic or audit fields |
+| `view-document-action.ts` | `viewKycDocument` Server Action — mints 300s presigned GET URL | Changing document access |
+| `ui.tsx` | Queue list client component | Queue UI changes |
+| `detail-ui.tsx` | Detail client component — badges, View button, Approve/Reject forms | Detail UI changes |
+| `README.md` | Invisible knowledge — two-layer auth rationale, KYC vs isVerified distinction | Before changing auth or state-transition logic |
+| `__tests__/action.test.ts` | Unit suite for approveOrRejectKyc | Changing action behaviour |
+| `__tests__/view-document-action.test.ts` | Unit suite for viewKycDocument | Changing document view behaviour |
```

**Documentation:**

```diff
--- a/src/features/admin/kyc-review/CLAUDE.md
+++ b/src/features/admin/kyc-review/CLAUDE.md
@@ -6,7 +6,7 @@ Admin KYC review slice. ADMIN role only.
 | File | What | When to read |
 | ---- | ---- | ------------ |
-| `page.tsx` | Queue RSC — lists SUBMITTED labs oldest-first | Adding queue columns or filters |
+| `page.tsx` | Queue RSC — lists SUBMITTED labs by lab creation order (Lab.createdAt asc) | Adding queue columns or filters |
 | `detail-page.tsx` | Detail RSC — one lab + documents; Decimal/Date DTO | Changing detail data shape |
 | `action.ts` | `approveOrRejectKyc` Server Action — CAS updateMany, doc cascade | Changing decision logic or audit fields |
 | `view-document-action.ts` | `viewKycDocument` Server Action — mints 300s presigned GET URL | Changing document access |

```


**CC-M-002-010** (src/features/admin/kyc-review/README.md) - implements CI-M-002-008

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/kyc-review/README.md
@@ -0,0 +1,55 @@
+# Admin KYC Review — Invisible Knowledge
+
+## Two-layer auth (DL-001)
+
+`src/app/dashboard/admin/layout.tsx` redirects non-ADMIN requests at the navigation layer.
+Every admin Server Action (`approveOrRejectKyc`, `viewKycDocument`) independently re-checks
+`session.user.role === ADMIN`. The layout guard does not protect Server Actions — they are
+independently POST-invocable, so a missing action-level re-check is a full privilege-escalation
+hole (TOCTOU). Both layers are mandatory.
+
+## KYC approval vs ISO 17025 accreditation — do not conflate (T-15 gotcha #3)
+
+`Lab.kycStatus` (this slice) is the **payment-gateway verification gate**:
+PENDING → SUBMITTED (T-15, first upload) → APPROVED|REJECTED (T-13, this slice).
+A lab with `kycStatus=APPROVED` can receive payments through checkout.
+
+`Lab.isVerified` is the **ISO 17025 accreditation / marketplace-visibility gate** (T-18).
+A lab with `isVerified=true` is listed as accredited in the marketplace.
+These are independent lifecycles. This slice does not touch `isVerified`.
+
+## kycStatus CAS transition (DL-002)
+
+`approveOrRejectKyc` writes the new status via:
+```ts
+tx.lab.updateMany({ where: { id, kycStatus: KycStatus.SUBMITTED }, data: { kycStatus: decision, … } })
+```
+`count === 0` means another admin already advanced the state → idempotent early-return.
+Never use a bare `update` here — it cannot detect concurrent review.
+
+## Presigned GET URL — on-click mint (DL-004)
+
+The detail RSC does **not** include `r2Key` in the DTO and does **not** embed presigned URLs
+in the page payload. The `viewKycDocument` action mints a 300s presigned GET URL on demand:
+1. Re-checks `role === ADMIN`.
+2. Loads `LabDocument.r2Key` from the DB (server-trusted, never from client input).
+3. Calls `generatePresignedGetUrl(key)` — enforces `labs/` prefix guard.
+4. Returns `{ url }` for `window.open`.
+
+Embedding the URL in the RSC payload would over-expose the credential for the full page
+lifetime and leak it into the Next.js router cache.
+
+## Audit columns — latest-review-only (DL-005)
+
+`kycReviewedById`, `kycReviewedAt`, `kycRejectionReason` on `Lab` capture only the **latest**
+review. A re-review overwrites all three fields. A full history table was rejected as
+disproportionate to the latest-only requirement.
+
+## First ADMIN — out-of-band bootstrap (DL-008)
+
+No in-app admin-minting path exists. The first admin is bootstrapped via:
+```sql
+UPDATE users SET role = 'ADMIN' WHERE email = '<admin-email>';
+```
+Self-service role management is spun out as T-13b.
```

**Documentation:**

```diff
--- a/src/features/admin/kyc-review/README.md
+++ b/src/features/admin/kyc-review/README.md
@@ -1,3 +1,3 @@
 # Admin KYC Review — Invisible Knowledge
 
 ## Two-layer auth (DL-001)
+
+## Queue ordering — lab creation order (DL-012)
+
+`page.tsx` orders the SUBMITTED queue by `Lab.createdAt asc`. There is no `kycSubmittedAt`
+column; `createdAt` (lab registration time) is the available proxy for queue age.
+FIFO on creation time bounds worst-case wait for any revenue-blocked lab.
+
+## Queue/detail UX split (DL-013)
+
+The queue page is list-only (one row per SUBMITTED lab). The detail page shows a single
+lab with per-document **View** links. This separation keeps the queue payload
+credential-free: presigned GET URLs are minted on demand in `viewKycDocument`, not
+embedded in the queue RSC payload. An all-in-one view would require minting every
+document URL up front, over-exposing credentials and breaking the on-click TTL-bounded
+mint (DL-004).
+
+## Migrations not committed (DL-011)
+
+`prisma/migrations/` is gitignored. The Lab audit columns (`kycReviewedById`,
+`kycReviewedAt`, `kycRejectionReason`) are applied per-environment via
+`npx prisma migrate dev`. `schema.prisma` is the committed source of truth.
+A fresh or CI environment missing the migrate step gets a runtime crash, not a
+type error. See the DevOps checklist in `docs/roadmap.md` for the apply command.

```


### Milestone 3: Lab-side rejection-reason surfacing on the KYC upload page

**Files**: src/features/labs/kyc-upload/page.tsx, src/features/labs/kyc-upload/ui.tsx

**Flags**: needs-rationale

**Requirements**:

- KycPageDTO carries kycRejectionReason: string | null.|The KYC upload UI shows the rejection reason to the lab when kycStatus===REJECTED and a reason is present.

**Acceptance Criteria**:

- A REJECTED lab with a stored reason sees that reason rendered on /dashboard/lab/kyc; an APPROVED or PENDING lab sees no reason block.|tsc clean; existing kyc-upload tests still pass.

**Tests**:

- {"files":[]
- "type":"unit"
- "backing":"doc-derived"
- "scenarios":{"normal":[]
- "edge":[]
- "error":[]}
- "skip_reason":"UI-only conditional render of an existing serialized field; covered by tsc and manual verification
- no new behavioral logic to unit-test"}

#### Code Intent

- **CI-M-003-001** `src/features/labs/kyc-upload/page.tsx::KycPage`: KycPageDTO carries kycRejectionReason: string | null. The page reads lab.kycRejectionReason and includes it in the DTO (already a plain string column, no serialization needed beyond null-coalescing). (refs: DL-006)
- **CI-M-003-002** `src/features/labs/kyc-upload/ui.tsx::KycUploadUi`: When dto.kycStatus===REJECTED and dto.kycRejectionReason is non-null, renders a reason block surfacing the admin-provided rejection reason to the lab; hidden for all other statuses. (refs: DL-006)

#### Code Changes

**CC-M-003-001** (src/features/labs/kyc-upload/page.tsx) - implements CI-M-003-001

**Code:**

```diff
--- a/src/features/labs/kyc-upload/page.tsx
+++ b/src/features/labs/kyc-upload/page.tsx
@@ -7,6 +7,7 @@ export type KycPageDTO = {
   kycStatus: KycStatus
+  kycRejectionReason: string | null
   documents: {
     id: string
     documentType: string
@@ -32,6 +33,7 @@ export default async function KycPage() {
   const dto: KycPageDTO = {
     kycStatus: lab.kycStatus,
+    kycRejectionReason: lab.kycRejectionReason ?? null,
     documents: lab.documents.map((doc) => ({
       id: doc.id,
       documentType: doc.documentType,

```

**Documentation:**

```diff
--- a/src/features/labs/kyc-upload/page.tsx
+++ b/src/features/labs/kyc-upload/page.tsx
@@ -7,6 +7,8 @@ export type KycPageDTO = {
   kycStatus: KycStatus
+  // Non-null when kycStatus=REJECTED; contains the admin's reason for rejection.
+  // Shown in the KYC upload UI so the lab owner knows what to correct before resubmitting. (ref: DL-006)
   kycRejectionReason: string | null

```


**CC-M-003-002** (src/features/labs/kyc-upload/ui.tsx) - implements CI-M-003-002

**Code:**

```diff
--- a/src/features/labs/kyc-upload/ui.tsx
+++ b/src/features/labs/kyc-upload/ui.tsx
@@ -103,6 +103,12 @@ export function KycUploadUi({ dto }: { dto: KycPageDTO }) {
           </div>
         </div>
 
+        {dto.kycStatus === 'REJECTED' && dto.kycRejectionReason && (
+          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
+            <h2 className="text-sm font-medium text-red-800 mb-1">KYC Rejected</h2>
+            <p className="text-sm text-red-700">{dto.kycRejectionReason}</p>
+          </div>
+        )}
+
         {dto.documents.length > 0 && (

```

**Documentation:**

```diff
--- a/src/features/labs/kyc-upload/ui.tsx
+++ b/src/features/labs/kyc-upload/ui.tsx
@@ -103,6 +103,8 @@ export function KycUploadUi({ dto }: { dto: KycPageDTO }) {
         </div>
       </div>

+      {/* Rejection reason banner — only rendered when kycStatus===REJECTED and a reason
+          was recorded. The reason is required by the admin action on reject. (ref: DL-006) */}
       {dto.kycStatus === 'REJECTED' && dto.kycRejectionReason && (

```


### Milestone 4: App-router wiring: admin route group, layout guard, dashboard nav, bootstrap docs

**Files**: src/app/dashboard/admin/layout.tsx, src/app/dashboard/admin/kyc/page.tsx, src/app/dashboard/admin/kyc/[labId]/page.tsx, docs/roadmap.md

**Flags**: security, needs-rationale

**Requirements**:

- src/app/dashboard/admin/layout.tsx calls auth() and redirects when role!==ADMIN
- wrapping all admin routes.|/dashboard/admin/kyc re-exports the queue page; /dashboard/admin/kyc/[labId] re-exports the detail page (thin dispatch
- matching the lab/kyc re-export pattern).|docs/roadmap.md records T-13 done
- the manual first-admin bootstrap SQL in the DevOps checklist
- and notes T-13b (role mgmt + order oversight) as the follow-up.

**Acceptance Criteria**:

- Visiting /dashboard/admin/* as a non-ADMIN redirects to /auth/signin via the layout guard; as ADMIN renders the queue.|Roadmap DevOps checklist contains the documented manual UPDATE statement to mint the first admin.|tsc clean; npm test passes.

**Tests**:

- {"files":[]
- "type":"unit"
- "backing":"doc-derived"
- "scenarios":{"normal":[]
- "edge":[]
- "error":[]}
- "skip_reason":"Thin re-export dispatch + layout guard mirrors existing app-router pattern; guard logic is unit-tested at the page/action level in M-002
- route wiring verified by tsc and manual navigation"}

#### Code Intent

- **CI-M-004-001** `src/app/dashboard/admin/layout.tsx::AdminLayout`: Async layout wrapping all /dashboard/admin routes. Calls auth(); when no session or session.user.role!==ADMIN, redirect to /auth/signin. Renders children. This is the navigation-layer guard only — Server Actions re-check independently (DL-001). (refs: DL-001)
- **CI-M-004-002** `src/app/dashboard/admin/kyc/page.tsx`: Thin re-export: export { default } from @/features/admin/kyc-review/page — mirroring the lab/kyc re-export dispatch pattern. (refs: DL-001)
- **CI-M-004-003** `src/app/dashboard/admin/kyc/[labId]/page.tsx`: Thin re-export: export { default } from @/features/admin/kyc-review/detail-page — the dynamic-segment params flow through to the detail RSC. (refs: DL-001)
- **CI-M-004-004** `docs/roadmap.md`: T-13 marked done (KYC-review surface). DevOps checklist gains an admin-access row with the documented manual bootstrap SQL (UPDATE users SET role=ADMIN WHERE email=...) and the note that no self-service admin minting exists. A T-13b follow-up entry records role management + order/transaction oversight as the spun-out scope. (refs: DL-008)

#### Code Changes

**CC-M-004-001** (src/app/dashboard/admin/layout.tsx) - implements CI-M-004-001

**Code:**

```diff
--- /dev/null
+++ b/src/app/dashboard/admin/layout.tsx
@@ -0,0 +1,19 @@
+import { redirect } from 'next/navigation'
+import { auth } from '@/lib/auth'
+
+export default async function AdminLayout({
+  children,
+}: {
+  children: React.ReactNode
+}) {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  return <>{children}</>
+}
```

**Documentation:**

```diff
--- a/src/app/dashboard/admin/layout.tsx
+++ b/src/app/dashboard/admin/layout.tsx
@@ -1,3 +1,10 @@
+/**
+ * Route-group layout guard for /dashboard/admin/*.
+ * Redirects non-ADMIN sessions before rendering any child page.
+ * This is layer 1 of the two-layer admin auth pattern. Layer 2 is the independent
+ * role===ADMIN re-check inside each Server Action — the layout guard does not protect
+ * Server Actions because they are independently POST-invocable (TOCTOU). (ref: DL-001)
+ */
 import { redirect } from 'next/navigation'
 import { auth } from '@/lib/auth'

```


**CC-M-004-002** (src/app/dashboard/admin/kyc/page.tsx) - implements CI-M-004-002

**Code:**

```diff
--- /dev/null
+++ b/src/app/dashboard/admin/kyc/page.tsx
@@ -0,0 +1 @@
+export { default } from '@/features/admin/kyc-review/page'
```

**Documentation:**

```diff
--- a/src/app/dashboard/admin/kyc/page.tsx
+++ b/src/app/dashboard/admin/kyc/page.tsx
@@ -1 +1,3 @@
+// Route entry point. Logic lives in the feature slice (ADR-001 VSA).
 export { default } from '@/features/admin/kyc-review/page'

```


**CC-M-004-003** (src/app/dashboard/admin/kyc/[labId]/page.tsx) - implements CI-M-004-003

**Code:**

```diff
--- /dev/null
+++ b/src/app/dashboard/admin/kyc/[labId]/page.tsx
@@ -0,0 +1 @@
+export { default } from '@/features/admin/kyc-review/detail-page'
```

**Documentation:**

```diff
--- a/src/app/dashboard/admin/kyc/[labId]/page.tsx
+++ b/src/app/dashboard/admin/kyc/[labId]/page.tsx
@@ -1 +1,3 @@
+// Route entry point. Logic lives in the feature slice (ADR-001 VSA).
 export { default } from '@/features/admin/kyc-review/detail-page'

```


**CC-M-004-004** (docs/roadmap.md) - implements CI-M-004-004

**Code:**

```diff
--- a/docs/roadmap.md
+++ b/docs/roadmap.md
@@ -314,7 +314,7 @@
 T-12 Attachment uploads                    [ready — T-06 ✅, R2 provisioned ✅] [planner]
-T-13 Admin panel                           [ready — T-01 ✅, T-15 ✅; priority↑ to approve labs] [planner]
+T-13 Admin panel — KYC review surface      [done — PR #TBD] [planner]
 
 T-14 Payment provider normalization        [done — PR #13] [planner]
@@ -389,8 +389,8 @@
-3/6 done (T-17 pulled into Phase 3, T-20 merged, T-15 done). T-13 priority↑ (needed to approve labs for payment).
+4/6 done (T-17 pulled into Phase 3, T-20 merged, T-15 done, T-13 KYC-review done).
 
 | Ticket | Blocker clears | Sessions | Notes |
 |--------|----------------|----------|-------|
 | T-17 PESONet virtual account | T-14 ✅ | 3 | ✅ done (PR #14) — pulled forward, completed in Phase 3 |
 | T-20 RA 10173 privacy compliance | T-05 ✅ | 2 | ✅ done (PR #15) — consent capture, privacy notice, enum-drift fence |
 | T-15 Lab KYC upload | T-02 ✅ | 2 | ✅ done (PR #16) — LabDocument model, KycStatus enum, R2 presigned PUT, checkout gate |
-| T-13 Admin panel | T-01 ✅ + T-15 ✅ | 3 | **Priority↑** — required to set kycStatus=APPROVED; gates T-18; Lab.isVerified + KycStatus admin writes |
+| T-13 Admin panel — KYC review surface | T-01 ✅ + T-15 ✅ | 1 | ✅ done (PR #TBD) — ADMIN-gated KYC review queue + approve/reject; T-13b (role mgmt + order oversight) is follow-up |
 | T-12 Attachment uploads | T-06 ✅ + R2 ✅ | 3 | **Now unblocked** — R2 provisioned (T-15); reuses src/lib/storage/r2.ts; client spec + lab result PDFs |
 | T-18 Lab accreditation verification | T-02 ✅ + T-13 | 2 | ITA 2023 compliance; still blocked by T-13 |
 | T-19 Dispute and redress | T-06 ✅ + T-07 ✅ | 2 | ITA 2023 internal redress; schema migration needed (DISPUTED status) |
@@ -405,9 +405,9 @@
 | Phase | Status | Coverage | MVP gate |
 |-------|--------|----------|----------|
 | 1 — Core flows | ✅ **COMPLETE** | 5/5 | |
 | 2 — Transactional | ✅ **COMPLETE** | 5/5 | |
 | 3 — Financial | ✅ **COMPLETE** | 4/4 | ✅ **MVP gate cleared** |
-| 4 — Post-MVP | 3/6 done | 50% | |
+| 4 — Post-MVP | 4/6 done | 67% | |
 
-**Phases 1–3 are complete.** T-15 merged 2026-05-29, closing Phase 2. Next: T-13 (admin panel — needed to approve labs for payment, priority↑) and T-12 (attachments — now unblocked by R2 provisioning).
+**Phases 1–3 are complete.** T-13 KYC-review surface merged (closes the approve path for labs). T-13b (role management + order oversight) is the follow-up. T-12 is next (attachments, now unblocked).
@@ -677,7 +677,7 @@
 ### T-13 — Admin panel `[planner]`
 **Branch:** `feat/T13-admin`
-**Status:** ready — T-01 ✅, T-15 ✅; priority↑ (needed to set kycStatus=APPROVED for labs)
+**Status:** done (KYC-review surface, PR #TBD) — T-13b (role mgmt + order oversight) is the follow-up
 **Why planner:** Scope is deliberately undefined at this stage — plan must define the surface area (which operations, which pages) before implementation. Touches role-gating across multiple existing slices and will likely require new middleware or layout-level auth guards.
 
-Lab verification (`isVerified`), user role management, order oversight.
+Lab verification (`isVerified`) and order oversight deferred to T-13b. KYC review surface shipped.
 `UserRole.ADMIN` exists in schema; no admin slices exist.
```

**Documentation:**

```diff
--- a/docs/roadmap.md
+++ b/docs/roadmap.md
@@ -163,6 +163,8 @@ Provider decided: **Cloudflare R2** ...
 - [ ] Prisma migrations applied to production DB (`npx prisma migrate deploy`)
+- [ ] **T-13 audit columns applied per-environment** — `prisma/migrations/` is gitignored (DL-011); run `npx prisma migrate dev` locally and on each Neon branch after pulling T-13. `schema.prisma` is the committed source of truth; missing this step causes a runtime crash on the audit fields, not a type error.
+- [ ] **First ADMIN user bootstrapped** — `UPDATE "User" SET role = 'ADMIN' WHERE email = '<admin-email>';` on the target Neon branch (DL-008). No in-app promotion path exists.
 - [ ] Connection pooling confirmed (Neon serverless driver or PgBouncer)
@@ -314,7 +314,7 @@
-T-13 Admin panel                           [ready — T-01 ✅, T-15 ✅; priority↑ to approve labs] [planner]
+T-13 Admin panel — KYC review surface      [done — PR #TBD] [planner]
+<!-- T-13 scope: KYC-review only. T-13b covers role-management + order oversight. -->

```


## Execution Waves

- W-001: M-001
- W-002: M-002, M-003
- W-003: M-004
