# Plan

## Overview

PipetGo lists and accepts orders for any active service regardless of whether the lab holds a valid ISO 17025 accreditation. Under ITA 2023 PipetGo bears solidary liability for unaccredited services it lists. There is no admin path to review an accreditation certificate, no lab path to upload one, and no server-side gate enforcing Lab.isVerified on the marketplace read (services/browse) or the order-creation write (create-order). isVerified exists on Lab but is never written or read.

**Approach**: Two new sibling VSA slices cloned from the shipped T-13 KYC pattern: labs/accreditation-upload/ (LAB_ADMIN presigned-PUT cert upload into LabDocument documentType=ACCREDITATION_CERTIFICATE, plus lab-side status/rejection surfacing) and admin/accreditation-review/ (ADMIN queue + detail with presigned-GET cert view + boolean-CAS verify/reject action writing Lab.isVerified and new accreditation audit columns). Two server-side gates enforce isVerified: services/browse findMany filters lab.isVerified=true, and create-order/action.ts re-fetch includes lab.isVerified and rejects unverified labs before the transaction (the ITA-liability control). Schema adds accreditation audit columns applied via prisma db push. Rollout bootstraps the first verified lab by self-reviewing a real cert through the new admin UI (preferred) with a documented manual UPDATE fallback, recorded in the roadmap DevOps checklist so the gated-empty /services is not read as a bug.

### T-18 accreditation gates + verify flow

[Diagram pending Technical Writer rendering: DIAG-001]

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Clone kyc-review -> admin/accreditation-review/ and kyc-upload -> labs/accreditation-upload/ as two new sibling VSA slices rather than parameterising the existing KYC slices by documentType | Parameterising would couple the shipped KYC path (confirm-action flips kycStatus PENDING->SUBMITTED) to a flow that has no status enum -> any regression risks the live payment gate -> clone gives different copy, different gate, no kycStatus coupling, and respects ADR-001 no-cross-slice-import (badge maps/DTOs copied verbatim) |
| DL-002 | Store the ISO 17025 certificate in LabDocument with documentType=ACCREDITATION_CERTIFICATE (status DocumentStatus, r2Key @unique), not Attachment | Attachment.orderId is NOT NULL (order-scoped) -> accreditation is lab-level so an Attachment row has no order to bind -> making orderId nullable touches every existing Attachment query null assumption -> LabDocument is already lab-scoped (T-15) and reused for KYC, so it is the correct home; the dead AttachmentType.ACCREDITATION_CERTIFICATE enum value stays unwired |
| DL-003 | The accreditation review queue filters labs with isVerified=false that own at least one LabDocument {documentType:ACCREDITATION_CERTIFICATE, status:UPLOADED}, ordered createdAt asc — no new accreditationStatus enum on Lab | accreditation has no status-enum lifecycle (unlike kycStatus) -> isVerified boolean is the existing marketplace/ITA gate field -> adding a parallel status enum would be redundant -> queue derives pending-state from (isVerified=false AND an UPLOADED cert doc exists) instead |
| DL-004 | Verify is a boolean compare-and-set: tx.lab.updateMany({where:{id, isVerified:false}, data:{isVerified:true, accreditationReviewedById, accreditationReviewedAt, accreditationRejectionReason:null}}) with count===0 early-return; reject sets isVerified stays false + records rejection reason; never a bare update | Two admins reviewing the same lab concurrently -> a bare update silently clobbers the first decision -> updateMany with the guard predicate in where is the CAS equivalent and count===0 means another delivery already advanced the state (CLAUDE.md webhook-CAS rule, action.ts:64 precedent) |
| DL-005 | The document cascade is scoped to documentType=ACCREDITATION_CERTIFICATE AND status:UPLOADED — NOT the unscoped {labId, status:UPLOADED} that kyc-review uses | kyc-review cascades ALL uploaded docs because a labs only docs today are KYC docs -> once accreditation docs coexist, an unscoped cascade in either slice clobbers the others UPLOADED docs (approve accreditation would VERIFY a pending KYC doc) -> both cascades must be documentType-scoped; this also obligates a follow-up note that kyc-review/action.ts cascade should be scoped when accreditation ships |
| DL-006 | Enforce the ITA liability gate in TWO server-side places: services/browse findMany adds where lab.isVerified:true (read gate), and create-order/action.ts re-fetch includes lab.isVerified and rejects when false BEFORE the $transaction (security-critical write gate) | UI hiding is not a control — a client can POST a serviceId directly to create-order -> the create-order re-fetch (TOCTOU guard) currently selects labService by id+isActive with no lab gate -> the server-side reject is the ITA-2023 solidary-liability-bearing control; the browse filter is the UX layer on top |
| DL-007 | Every admin accreditation Server Action independently re-checks session.user.role===ADMIN; lab-side actions re-check ownership via Lab.ownerId===session.user.id | Server Actions are POST-invocable without navigating through any page -> the admin/layout.tsx route-group guard does not protect actions (TOCTOU, DL-001) -> each action must re-derive identity from auth() and reject mismatches before any write |
| DL-008 | All FormData boundary inputs are typeof-narrowed (typeof x===string ? x : null) — never `as string`; no masking ?? fallback on contract-guaranteed fields | kyc-upload upload-action/confirm-action predate the PR #17 boundary-coercion rule and use formData.get(...) as string -> copying that verbatim reintroduces the banned pattern -> admin/kyc-review/action.ts (typeof-narrowed) is the canonical clone source, not kyc-upload |
| DL-009 | Add Lab audit columns accreditationReviewedById/accreditationReviewedAt/accreditationRejectionReason + named relation LabAccreditationReviewer with a User inverse; apply via `npx prisma db push`, never `migrate dev`; do not commit migration files | prisma/migrations/ is gitignored (DL-011) and the dev Neon DB is push-managed -> running migrate dev would drift or reset the push-managed branch -> schema.prisma is the committed source of truth and db push reconciles it; named relation required because Lab already has the kycReviewedBy relation to User (Prisma needs a distinct relation name) |
| DL-010 | Bootstrap the first verified lab post-deploy by self-reviewing one labs accreditation certificate through the new admin UI (preferred), with a documented manual `UPDATE labs SET isVerified=true WHERE id=<lab-id>;` (per-environment, gitignored-migration-style) as the fallback only; record both in docs/roadmap.md Infrastructure & DevOps Provisioning checklist consistent with the T-13 first-admin bootstrap (DL-008 style) | Gating /services on lab.isVerified=true empties the marketplace until a lab is verified (no lab has isVerified=true yet) -> an empty /services would read as a bug post-deploy -> self-reviewing a real cert through the admin verify flow exercises the actual CAS + cascade path and leaves an audit trail via accreditationReviewedById/At, whereas the raw UPDATE leaves no reviewer audit -> the manual UPDATE is the fallback for environments without a seeded cert; both belong in the per-environment DevOps checklist so the empty marketplace is not mistaken for a defect |
| DL-011 | Surface accreditation status (isVerified) and accreditationRejectionReason back to the lab owner on the accreditation-upload page; presigned GET URLs for cert view are derived server-side from the trusted LabDocument.r2Key with a 300s TTL | A rejected lab needs to see why to re-upload (mirrors T-13 M-003 lab-side banner) -> the reason lives on Lab.accreditationRejectionReason written by the reject path -> presigned GET must use the server-trusted r2Key (never a client-supplied key) per view-document-action.ts/DL-004 to prevent IDOR on the object store |
| DL-012 | Testing is unit-only with full Prisma mocks (vitest), mock method names aligned exactly to each handlers Prisma call; the create-order gate gets a dedicated test mirroring checkout kyc-gate.test.ts | A misnamed mock (e.g. lab.update when the handler calls lab.updateMany) silently voids the CAS error-propagation assertion (CLAUDE.md rollback-test rule) -> aligning names keeps the assertion real -> the create-order gate is the liability control so it gets an explicit unverified-lab-rejected test, not just coverage by inference |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Store the cert in Attachment with AttachmentType.ACCREDITATION_CERTIFICATE | Attachment.orderId is NOT NULL (order-scoped); accreditation is lab-level so an Attachment row has no order to bind. The enum value stays dead/unwired. (ref: DL-002) |
| Make orderId nullable on Attachment to host the cert | Touches every existing Attachment query null assumption — disproportionate vs reusing the already-lab-scoped LabDocument. (ref: DL-002) |
| Add an accreditationStatus enum on Lab mirroring kycStatus | isVerified boolean is the existing marketplace/ITA gate; a parallel status enum is redundant. Queue derives pending-state from isVerified=false plus an UPLOADED cert doc. (ref: DL-003) |
| Parameterise the existing kyc-upload/kyc-review slices by documentType instead of cloning | Couples the shipped KYC path (kycStatus transitions, live payment gate) to a flow with no status enum; higher regression risk than cloning sibling slices. (ref: DL-001) |
| Gate the marketplace only in the /services UI | Insufficient — a client can POST a serviceId directly to create-order. The server-side reject in create-order/action.ts is the ITA-liability-bearing control. (ref: DL-006) |
| Bootstrap the first verified lab solely via raw UPDATE labs SET isVerified=true | Leaves no reviewer audit trail (accreditationReviewedById/At null) and never exercises the real CAS+cascade verify path. Kept only as the documented fallback; admin self-review is preferred. (ref: DL-010) |

### Constraints

- Reuse LabDocument (lab-scoped, r2Key @unique, DocumentStatus, R2 PUT+GET) for the cert — never Attachment (orderId NOT NULL). [C-001]
- isVerified is independent of kycStatus — T-18 reads/writes only isVerified; never touches kycStatus. [C-002]
- Verify is a boolean CAS via updateMany + count===0 early-return; never a bare update. [C-003]
- Doc cascade scoped to documentType=ACCREDITATION_CERTIFICATE AND status:UPLOADED — never the unscoped kyc-review cascade. [C-004]
- create-order/action.ts rejects server-side when target service lab.isVerified===false, before the transaction. [C-005]
- Every admin accreditation Server Action re-checks role===ADMIN (TOCTOU); lab actions re-check Lab.ownerId. [C-006]
- Boundary FormData inputs typeof-narrowed (never as string); no masking ?? fallback on contract-guaranteed fields (PR #17 rule). [C-007]
- Presigned GET URL (300s) from server-trusted LabDocument.r2Key, never a client-supplied key. [C-008]
- RSC DTOs serialize Date->toISOString and Decimal->toFixed(2) before crossing to client. [C-009]
- findUnique on @unique fields; null relation after explicit include throws; missing/wrong-owner notFound; redirect() after — never inside — try/catch; badge maps as const satisfies Record. [C-010]
- Apply audit columns via npx prisma db push (dev DB push-managed); migrations gitignored (DL-011); do not commit migration files. [C-011]
- documentType allowlist for the cert upload path must include ACCREDITATION_CERTIFICATE (upload-action throws on unknown documentType). [C-012]

### Known Risks

- **Clone drift: copy-paste leaves a kycStatus reference in the accreditation action, silently coupling T-18 to the live payment gate.**: Owner: M-002 & M-003 (the cloned slices that carry the mitigation). Grep the new slices for kyc/kycStatus/KycStatus before PR; confirm-action and action.ts touch only isVerified + accreditation columns. Landed as M-002 acceptance ('grep of the slice finds no kyc/kycStatus reference') and enforced across M-003 action/confirm intents.
- **Unscoped cascade clobbers cross-domain docs: an unscoped UPLOADED cascade in either review slice advances the others pending docs.**: Owner: M-003 owns the accreditation-side fix (scope the new cascade to documentType=ACCREDITATION_CERTIFICATE AND status:UPLOADED per DL-005 / CI-M-003-003); M-006 owns the deferred kyc-review retro-scoping follow-up (CI-M-006-002 adds the tracked deferral note to kyc-review/README.md that the shipped, currently-unscoped KYC cascade MUST be documentType-scoped before any second non-KYC doc type is reviewed through that slice). The shipped KYC cascade is explicitly deferred, not silently dropped.
- **Empty-marketplace surprise: gating /services empties it until a lab is verified and may be read as a bug post-deploy.**: Owner: M-006 (DevOps rollout + docs). Document the rollout (preferred admin self-review of one cert; fallback manual UPDATE) in the roadmap DevOps checklist; note empty /services is intentional. Landed as M-006 requirement + CI-M-006-001.
- **Reintroducing the banned as string boundary coercion by cloning kyc-upload verbatim (it predates PR #17).**: Owner: M-002 (accreditation-upload actions) & M-005 (create-order serviceId narrowing). Clone boundary handling from admin/kyc-review/action.ts (typeof-narrowed), not kyc-upload; verify no as string casts on FormData in the new slices. Landed via DL-008 in CI-M-002-001 and CI-M-005-001.
- **Migration drift: running prisma migrate dev against the push-managed dev branch drifts or resets it.**: Owner: M-001 (schema milestone). Apply schema via prisma db push only; never commit a migration file; schema.prisma is the source of truth. Landed as M-001 acceptance ('no file added under prisma/migrations/') + CI-M-001-001 per DL-009.

## Invisible Knowledge

### System

PipetGo enforces TWO independent lab gates with separate lifecycles: kycStatus (T-13/T-15 payment/onboarding gate, status-enum lifecycle PENDING->SUBMITTED->APPROVED/REJECTED) and isVerified (T-18 ISO-17025 marketplace/ITA gate, a boolean with no status enum). A lab can be kycStatus=APPROVED yet isVerified=false. T-18 reads/writes ONLY isVerified and its accreditation audit columns; it must never touch kycStatus. The accreditation certificate lives in LabDocument (lab-scoped, r2Key @unique) with documentType=ACCREDITATION_CERTIFICATE — NOT in Attachment (order-scoped, orderId NOT NULL). The dead AttachmentType.ACCREDITATION_CERTIFICATE enum value stays unwired.

### Invariants

- isVerified is the ITA-2023 solidary-liability marketplace gate; the create-order/action.ts server-side reject (not the /services UI filter) is the liability-bearing control because a client can POST a serviceId directly.
- Verify/reject is a boolean compare-and-set: tx.lab.updateMany({where:{id, isVerified:false}}) with a count===0 early-return — never a bare update — so concurrent admin reviews cannot clobber each other.
- The accreditation document cascade must be scoped to documentType=ACCREDITATION_CERTIFICATE AND status:UPLOADED. The shipped kyc-review cascade is unscoped ({labId, status:UPLOADED}) and is safe ONLY while a lab has no non-KYC docs; once accreditation docs coexist, an unscoped cascade in either slice clobbers the others UPLOADED docs.
- Every admin accreditation Server Action independently re-checks role===ADMIN; lab-side actions re-check Lab.ownerId — the layout route-group guard does not protect POST-invocable Server Actions (TOCTOU, DL-001).
- Presigned GET/PUT URLs are derived from the server-trusted LabDocument.r2Key (300s GET TTL), never from a client-supplied key (IDOR guard).
- RSC DTOs serialize Date->toISOString and Decimal->toFixed(2) before crossing to client components.
- Schema changes apply via prisma db push on each push-managed Neon branch; prisma/migrations/ is gitignored and schema.prisma is the committed source of truth; migrate dev would drift/reset the dev branch.

### Tradeoffs

- Cloning the KYC slices (vs parameterising by documentType) duplicates badge maps/DTOs and copy, but isolates the shipped live payment-gate KYC path from regression and honors ADR-001 no-cross-slice-import.
- Gating /services on isVerified empties the marketplace until a lab is verified; mitigated by the rollout bootstrap (preferred: admin self-review of one real cert, which leaves an audit trail; fallback: manual UPDATE), documented in the roadmap DevOps checklist so the empty state is not read as a bug.
- No accreditationStatus enum is added; the queue derives pending-state from (isVerified=false AND an UPLOADED accreditation cert exists), keeping isVerified the single gate field at the cost of a slightly more complex queue predicate.

## Milestones

### Milestone 1: Schema — Lab accreditation audit columns + relation

**Files**: prisma/schema.prisma

**Flags**: needs-rationale

**Requirements**:

- Add Lab.accreditationReviewedById (nullable String)
- Lab.accreditationReviewedAt (nullable DateTime)
- Lab.accreditationRejectionReason (nullable String); add named relation LabAccreditationReviewer from Lab to User with the inverse on User; apply via npx prisma db push (never migrate dev); do not commit any prisma/migrations file

**Acceptance Criteria**:

- npx prisma generate succeeds and Prisma Client exposes the three new Lab fields; npx prisma db push applies cleanly to a push-managed dev branch; npx tsc --noEmit clean; no file added under prisma/migrations/

**Tests**:

- none — schema-only milestone; verified by prisma generate + tsc

#### Code Intent

- **CI-M-001-001** `prisma/schema.prisma::model Lab`: Hold three nullable accreditation audit columns: accreditationReviewedById (String?), accreditationReviewedAt (DateTime?), accreditationRejectionReason (String?). Relate accreditationReviewedById to User via a named relation LabAccreditationReviewer (distinct from the existing kycReviewedBy relation). isVerified already exists and is the gate field — no new status enum is added. Schema reconciled with the dev DB via prisma db push; no migration file is committed. (refs: DL-003, DL-009)
- **CI-M-001-002** `prisma/schema.prisma::model User`: Expose the inverse relation field for LabAccreditationReviewer so a User can be the accreditation reviewer of many Labs, mirroring the existing KYC reviewer inverse. (refs: DL-009)

#### Code Changes

**CC-M-001-001** (prisma/schema.prisma) - implements CI-M-001-001

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -146,6 +146,9 @@ model Lab {
   isVerified     Boolean  @default(false)
   kycStatus      KycStatus @default(PENDING)
   createdAt      DateTime @default(now())
   updatedAt      DateTime @updatedAt
   // Latest-review-only audit — re-review overwrites all three fields. (ref: DL-005)
   kycReviewedById    String?
   kycReviewedAt      DateTime?
   kycRejectionReason String?
+  // Accreditation audit — latest-review-only; re-review overwrites all three. Independent of kycStatus. (ref: DL-005)
+  accreditationReviewedById    String?
+  accreditationReviewedAt      DateTime?
+  accreditationRejectionReason String?
 
   owner       User         @relation(fields: [ownerId], references: [id])
   reviewer    User?        @relation("LabKycReviewer", fields: [kycReviewedById], references: [id])
+  accreditationReviewer User? @relation("LabAccreditationReviewer", fields: [accreditationReviewedById], references: [id])
   services    LabService[]
   orders      Order[]
   attachments Attachment[]
   wallet      LabWallet?
   payouts     Payout[]
   documents   LabDocument[]
 
   @@map("labs")
 }
```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -146,6 +146,7 @@ model Lab {
   isVerified     Boolean  @default(false)
   kycStatus      KycStatus @default(PENDING)
   // Accreditation audit — latest-review-only; re-review overwrites all three. Independent of kycStatus. (ref: DL-005)
+  // Named relation 'LabAccreditationReviewer' required: Lab already has a kycReviewedBy relation to User; Prisma needs a distinct relation name. (ref: DL-009)
   accreditationReviewedById    String?

```


**CC-M-001-002** (prisma/schema.prisma) - implements CI-M-001-002

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -96,6 +96,7 @@ model User {
   labDocuments LabDocument[]
   // Named relation back-reference for kycReviewedById on Lab. (ref: DL-005)
   kycReviewedLabs Lab[] @relation("LabKycReviewer")
+  accreditationReviewedLabs Lab[] @relation("LabAccreditationReviewer")
 
   @@map("users")
 }
```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -96,6 +96,7 @@ model User {
   labDocuments LabDocument[]
   // Named relation back-reference for kycReviewedById on Lab. (ref: DL-005)
   kycReviewedLabs Lab[] @relation("LabKycReviewer")
+  // Back-reference for accreditationReviewedById. Distinct relation name required because User already has kycReviewedLabs. (ref: DL-009)
   accreditationReviewedLabs Lab[] @relation("LabAccreditationReviewer")

```


### Milestone 2: labs/accreditation-upload/ slice — LAB_ADMIN cert upload + status surfacing

**Files**: src/features/labs/accreditation-upload/upload-action.ts, src/features/labs/accreditation-upload/confirm-action.ts, src/features/labs/accreditation-upload/page.tsx, src/features/labs/accreditation-upload/ui.tsx, src/app/dashboard/lab/accreditation/page.tsx

**Flags**: error-handling, needs-rationale

**Requirements**:

- Two-step presigned PUT upload of an ISO 17025 cert into LabDocument with documentType=ACCREDITATION_CERTIFICATE; documentType allowlist constant includes ACCREDITATION_CERTIFICATE and throws on unknown; all FormData inputs typeof-narrowed (never as string); confirm-action records the LabDocument as UPLOADED and does NOT touch Lab.kycStatus; lab-side page surfaces current isVerified state and accreditationRejectionReason; ownership re-checked via Lab.ownerId===session.user.id in every action

**Acceptance Criteria**:

- A LAB_ADMIN can presign-PUT a cert and the LabDocument row persists with documentType=ACCREDITATION_CERTIFICATE status=UPLOADED; kycStatus is unchanged; a rejected lab sees its rejection reason; unknown documentType throws; grep of the slice finds no kyc/kycStatus reference

**Tests**:

- unit (vitest) — upload-action allowlist throws on unknown documentType; confirm-action never writes kycStatus; ownership mismatch rejected

#### Code Intent

- **CI-M-002-001** `src/features/labs/accreditation-upload/upload-action.ts::requestAccreditationUpload`: Authorize the caller as a LAB_ADMIN owning the target lab (Lab.ownerId===session.user.id via findUnique), validate documentType against an allowlist constant that includes ACCREDITATION_CERTIFICATE and throws on any unknown value, narrow all FormData inputs with typeof x===string (never as string), and return a presigned PUT URL plus the LabDocument r2Key from generatePresignedPutUrl. Never read or write Lab.kycStatus. (refs: DL-002, DL-008, DL-011)
- **CI-M-002-002** `src/features/labs/accreditation-upload/confirm-action.ts::confirmAccreditationUpload`: Re-check lab ownership, persist the uploaded cert as a LabDocument row with documentType=ACCREDITATION_CERTIFICATE and status=UPLOADED, and return success. Unlike the KYC confirm-action it does NOT transition Lab.kycStatus and writes nothing on Lab — accreditation has no status enum; the only Lab-level state is isVerified, set later by the admin. (refs: DL-001, DL-003, DL-011)
- **CI-M-002-003** `src/features/labs/accreditation-upload/page.tsx::AccreditationUploadPage`: As an RSC, load the owning lab via findUnique (ownership re-checked) and surface its current isVerified state and accreditationRejectionReason to the LAB_ADMIN so a rejected lab knows why and can re-upload. Serialize any Date via toISOString before crossing to the client UI component. (refs: DL-011)
- **CI-M-002-004** `src/features/labs/accreditation-upload/ui.tsx::AccreditationUploadForm`: Client component driving the two-step presigned PUT (request URL, PUT file to R2, confirm) and rendering the verification status banner (verified / pending / rejected-with-reason). Badge/status maps declared as const satisfies Record over the relevant enum, copied into this slice (no cross-slice import per ADR-001). (refs: DL-001, DL-011)
- **CI-M-002-005** `src/app/dashboard/lab/accreditation/page.tsx::default`: App-router mount that re-exports the accreditation-upload slice page under /dashboard/lab/accreditation (analogous to the KYC mount; reached by direct URL). (refs: DL-001)

#### Code Changes

**CC-M-002-001** (src/features/labs/accreditation-upload/upload-action.ts) - implements CI-M-002-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/labs/accreditation-upload/upload-action.ts
@@ -0,0 +1,73 @@
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
+// documentType value used throughout this slice for ISO 17025 accreditation certificates.
+// Listed explicitly in the allowlist — throws on any unknown value so schema evolution
+// surfaces as an error rather than silent data corruption. (ref: CLAUDE.md unhandled-states)
+const DOCUMENT_TYPE_ALLOWLIST = ['ACCREDITATION_CERTIFICATE'] as const
+
+const EXT_BY_MIME = {
+  'application/pdf': 'pdf',
+  'image/jpeg': 'jpg',
+  'image/png': 'png',
+} as const satisfies Record<typeof ALLOWED_MIME_TYPES[number], string>
+
+export async function requestUploadUrl(
+  _prev: ActionState | { presignedUrl: string; r2Key: string; labDocumentId: string },
+  formData: FormData,
+): Promise<ActionState | { presignedUrl: string; r2Key: string; labDocumentId: string }> {
+  const fileNameValue = formData.get('fileName')
+  const mimeTypeValue = formData.get('mimeType')
+  const fileSizeRaw = formData.get('fileSize')
+  const documentTypeValue = formData.get('documentType')
+
+  const fileName = typeof fileNameValue === 'string' ? fileNameValue : null
+  const mimeType = typeof mimeTypeValue === 'string' ? mimeTypeValue : null
+  const documentType = typeof documentTypeValue === 'string' ? documentTypeValue : null
+
+  if (!fileName || !mimeType || !fileSizeRaw || !documentType) {
+    return { message: 'Missing field.' }
+  }
+
+  const fileSize = Number(fileSizeRaw)
+  if (!Number.isFinite(fileSize) || fileSize <= 0) {
+    return { message: 'Invalid file size.' }
+  }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id } })
+  if (!lab) return { message: 'No lab found for user.' }
+
+  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
+    return { message: 'Unsupported file type. Allowed: PDF, JPEG, PNG.' }
+  }
+  if (fileSize > MAX_BYTES) {
+    return { message: 'File exceeds 20 MB limit.' }
+  }
+
+  if (!(DOCUMENT_TYPE_ALLOWLIST as readonly string[]).includes(documentType)) {
+    throw new Error(`Unknown documentType: ${documentType}`)
+  }
+
+  const ext = EXT_BY_MIME[mimeType as typeof ALLOWED_MIME_TYPES[number]]
+  const r2Key = `labs/${lab.id}/${createId()}.${ext}`
+
+  const doc = await prisma.labDocument.create({
+    data: { labId: lab.id, uploadedById: session.user.id, documentType, r2Key, fileName, fileSize, mimeType, status: 'PENDING' },
+  })
+
+  try {
+    const presignedUrl = await generatePresignedPutUrl(r2Key, mimeType, fileSize)
+    return { presignedUrl, r2Key, labDocumentId: doc.id }
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
--- a/src/features/labs/accreditation-upload/upload-action.ts
+++ b/src/features/labs/accreditation-upload/upload-action.ts
@@ -23,6 +23,14 @@ const EXT_BY_MIME = {
   'image/png': 'png',
 } as const satisfies Record<typeof ALLOWED_MIME_TYPES[number], string>
 
+/**
+ * Generates a presigned R2 PUT URL for an ISO 17025 accreditation certificate upload.
+ *
+ * Two-step flow: this action returns the URL + a LabDocument id; the client PUTs the
+ * file directly to R2, then calls confirmUpload to advance the LabDocument to UPLOADED.
+ * Role-checked as LAB_ADMIN before any storage or DB write. (ref: DL-007)
+ * documentType is validated against DOCUMENT_TYPE_ALLOWLIST — unknown values throw rather
+ * than silently inserting an unrecognised type. (ref: CLAUDE.md unhandled-states)
+ */
 export async function requestUploadUrl(

```


**CC-M-002-002** (src/features/labs/accreditation-upload/confirm-action.ts) - implements CI-M-002-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/labs/accreditation-upload/confirm-action.ts
@@ -0,0 +1,46 @@
+'use server'
+
+import { revalidatePath } from 'next/cache'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+
+type ActionState = { message?: string } | null
+
+// Accreditation confirm differs from KYC confirm: it does NOT transition Lab.kycStatus.
+// isVerified is the admin-only gate; only the admin verify action sets it to true.
+// This action only advances the LabDocument from PENDING to UPLOADED.
+export async function confirmUpload(
+  _prev: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const labDocumentIdValue = formData.get('labDocumentId')
+  const labDocumentId = typeof labDocumentIdValue === 'string' ? labDocumentIdValue : null
+  if (!labDocumentId) return { message: 'Missing labDocumentId.' }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id } })
+  if (!lab) return { message: 'No lab found for user.' }
+
+  let updateCount = 0
+  await prisma.$transaction(async (tx) => {
+    const result = await tx.labDocument.updateMany({
+      where: { id: labDocumentId, labId: lab.id, status: 'PENDING' },
+      data: { status: 'UPLOADED' },
+    })
+    updateCount = result.count
+  })
+
+  // count===0: doc not found, already UPLOADED, or wrong lab — return early without reporting success.
+  if (updateCount === 0) {
+    return { message: 'Document not found or already submitted.' }
+  }
+
+  revalidatePath('/dashboard/lab/accreditation')
+
+  return null
+}
```

**Documentation:**

```diff
--- a/src/features/labs/accreditation-upload/confirm-action.ts
+++ b/src/features/labs/accreditation-upload/confirm-action.ts
@@ -1,3 +1,5 @@
 'use server'
+// Slice: labs/accreditation-upload. Does not transition kycStatus. See README.md.
 
 import { revalidatePath } from 'next/cache'

```


**CC-M-002-003** (src/features/labs/accreditation-upload/page.tsx) - implements CI-M-002-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/labs/accreditation-upload/page.tsx
@@ -0,0 +1,51 @@
+import { notFound, redirect } from 'next/navigation'
+import { type DocumentStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { AccreditationUploadUi } from './ui'
+
+export type AccreditationPageDTO = {
+  // isVerified reflects whether the admin has verified the ISO 17025 certificate.
+  // Distinct from kycStatus — these are independent lifecycle states.
+  isVerified: boolean
+  // Non-null when a previous accreditation submission was rejected; shown so the
+  // lab owner knows what to correct before re-uploading.
+  accreditationRejectionReason: string | null
+  documents: {
+    id: string
+    documentType: string
+    fileName: string
+    mimeType: string
+    status: DocumentStatus
+    createdAt: string
+  }[]
+}
+
+export default async function AccreditationPage() {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  const lab = await prisma.lab.findUnique({
+    where: { ownerId: session.user.id },
+    include: {
+      documents: {
+        where: { documentType: 'ACCREDITATION_CERTIFICATE' },
+        orderBy: { createdAt: 'desc' },
+      },
+    },
+  })
+
+  if (!lab) notFound()
+
+  const dto: AccreditationPageDTO = {
+    isVerified: lab.isVerified,
+    accreditationRejectionReason: lab.accreditationRejectionReason ?? null,
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
+  return <AccreditationUploadUi dto={dto} />
+}
```

**Documentation:**

```diff
--- a/src/features/labs/accreditation-upload/page.tsx
+++ b/src/features/labs/accreditation-upload/page.tsx
@@ -1,3 +1,5 @@
+// Slice: labs/accreditation-upload. See README.md for isVerified vs kycStatus distinction.
+// RSC — all Date fields serialized to ISO string before crossing to AccreditationUploadUi. (ref: DL-009)
 import { notFound, redirect } from 'next/navigation'

```


**CC-M-002-004** (src/features/labs/accreditation-upload/ui.tsx) - implements CI-M-002-004

**Code:**

```diff
--- /dev/null
+++ b/src/features/labs/accreditation-upload/ui.tsx
@@ -0,0 +1,151 @@
+'use client'
+
+import { useActionState, useRef, useEffect, useState } from 'react'
+import { type DocumentStatus } from '@prisma/client'
+import { requestUploadUrl } from './upload-action'
+import { confirmUpload } from './confirm-action'
+import type { AccreditationPageDTO } from './page'
+import { ALLOWED_MIME_TYPES, MAX_BYTES } from '@/lib/storage/constants'
+
+// VERIFIED_BADGE is a two-value map rather than Record<KycStatus> because isVerified
+// is a boolean, not an enum. Satisfies ensures exhaustive handling of both states.
+const VERIFIED_BADGE: Record<'verified' | 'pending', { label: string; className: string }> = {
+  verified: { label: 'Accredited',      className: 'bg-green-200 text-green-800' },
+  pending:  { label: 'Pending review',  className: 'bg-yellow-200 text-yellow-800' },
+}
+
+const DOC_STATUS_BADGE = {
+  PENDING:  { label: 'Pending upload', className: 'bg-gray-100 text-gray-600' },
+  UPLOADED: { label: 'Uploaded',       className: 'bg-blue-100 text-blue-700' },
+  VERIFIED: { label: 'Verified',       className: 'bg-green-100 text-green-700' },
+  REJECTED: { label: 'Rejected',       className: 'bg-red-100 text-red-700' },
+} as const satisfies Record<DocumentStatus, { label: string; className: string }>
+
+type UploadResult = { presignedUrl: string; r2Key: string; labDocumentId: string }
+type UploadState = { message?: string } | UploadResult | null
+type ConfirmState = { message?: string } | null
+
+export function AccreditationUploadUi({ dto }: { dto: AccreditationPageDTO }) {
+  const badge = dto.isVerified ? VERIFIED_BADGE.verified : VERIFIED_BADGE.pending
+  const fileRef = useRef<HTMLInputElement>(null)
+
+  const [uploadState, uploadAction, uploadPending] = useActionState(
+    requestUploadUrl,
+    null as UploadState,
+  )
+  const [confirmState, confirmAction, confirmPending] = useActionState(
+    confirmUpload,
+    null as ConfirmState,
+  )
+
+  const [putError, setPutError] = useState<string | null>(null)
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
+        confirmFormData.set('labDocumentId', result.labDocumentId)
+        void confirmAction(confirmFormData)
+      } catch (err) {
+        setPutError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
+      }
+    })()
+  }, [uploadState, confirmAction])
+
+  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
+    e.preventDefault()
+    setPutError(null)
+    const form = e.currentTarget
+    const fileInput = fileRef.current
+    if (!fileInput?.files?.[0]) return
+
+    const file = fileInput.files[0]
+
+    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
+      return
+    }
+    if (file.size > MAX_BYTES) {
+      return
+    }
+
+    const uploadFormData = new FormData(form)
+    uploadFormData.set('fileName', file.name)
+    uploadFormData.set('mimeType', file.type)
+    uploadFormData.set('fileSize', String(file.size))
+    void uploadAction(uploadFormData)
+  }
+
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
+        <div className="mb-6">
+          <h1 className="text-2xl font-bold text-gray-900">ISO 17025 Accreditation</h1>
+          <div className="mt-2">
+            <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${badge.className}`}>
+              {badge.label}
+            </span>
+          </div>
+        </div>
+
+        {/* Rejection reason banner — shown when a previous cert was rejected so the lab
+            owner knows what to correct before re-uploading. */}
+        {!dto.isVerified && dto.accreditationRejectionReason && (
+          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
+            <h2 className="text-sm font-medium text-red-800 mb-1">Accreditation Rejected</h2>
+            <p className="text-sm text-red-700">{dto.accreditationRejectionReason}</p>
+          </div>
+        )}
+
+        {dto.documents.length > 0 && (
+          <div className="mb-6 bg-white rounded-lg shadow p-4">
+            <h2 className="text-sm font-medium text-gray-700 mb-3">Uploaded Certificates</h2>
+            <ul className="divide-y divide-gray-100">
+              {dto.documents.map((doc) => {
+                const db = DOC_STATUS_BADGE[doc.status]
+                return (
+                  <li key={doc.id} className="py-2 flex items-center justify-between">
+                    <span className="text-sm text-gray-800">{doc.fileName}</span>
+                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${db.className}`}>
+                      {db.label}
+                    </span>
+                  </li>
+                )
+              })}
+            </ul>
+          </div>
+        )}
+
+        {!dto.isVerified && (
+          <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4">
+            <input type="hidden" name="documentType" value="ACCREDITATION_CERTIFICATE" />
+            <div>
+              <label className="block text-sm font-medium text-gray-700 mb-1">ISO 17025 Certificate (PDF, JPEG, PNG — max 20 MB)</label>
+              <input
+                ref={fileRef}
+                type="file"
+                accept="application/pdf,image/jpeg,image/png"
+                required
+                className="block w-full text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
+              />
+            </div>
+            {uploadState && 'message' in uploadState && uploadState.message && (
+              <p className="text-sm text-red-600">{uploadState.message}</p>
+            )}
+            {confirmState && 'message' in confirmState && confirmState.message && (
+              <p className="text-sm text-red-600">{confirmState.message}</p>
+            )}
+            {putError && (
+              <p className="text-sm text-red-600">{putError}</p>
+            )}
+            <button
+              type="submit"
+              disabled={uploadPending || confirmPending}
+              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
+            >
+              {uploadPending || confirmPending ? 'Uploading…' : 'Upload Certificate'}
+            </button>
+          </form>
+        )}
+      </div>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/labs/accreditation-upload/ui.tsx
+++ b/src/features/labs/accreditation-upload/ui.tsx
@@ -1,3 +1,5 @@
 'use client'
+// Client component for the accreditation upload page. Two-step upload: request presigned PUT
+// URL via Server Action, PUT to R2 via browser fetch, then confirm via Server Action. (ref: DL-001)
 
 import { useActionState, useRef, useEffect, useState } from 'react'

```


**CC-M-002-005** (src/app/dashboard/lab/accreditation/page.tsx) - implements CI-M-002-005

**Code:**

```diff
--- /dev/null
+++ b/src/app/dashboard/lab/accreditation/page.tsx
@@ -0,0 +1,2 @@
+// Route entry point. Logic lives in the feature slice (ADR-001 VSA).
+export { default } from '@/features/labs/accreditation-upload/page'
```

**Documentation:**

```diff
--- a/src/app/dashboard/lab/accreditation/page.tsx
+++ b/src/app/dashboard/lab/accreditation/page.tsx
@@ -1,2 +1,3 @@
 // Route entry point. Logic lives in the feature slice (ADR-001 VSA).
+// Feature slice: src/features/labs/accreditation-upload/page.tsx
 export { default } from '@/features/labs/accreditation-upload/page'

```


**CC-M-002-006** (src/features/labs/accreditation-upload/README.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/labs/accreditation-upload/README.md
@@ -0,0 +1,55 @@
+# accreditation-upload — Design Decisions
+
+## Slice origin — cloned from kyc-upload (DL-001)
+
+This slice is a sibling clone of `labs/kyc-upload/`, not a parameterised extension.
+`kyc-upload/confirm-action` transitions `Lab.kycStatus PENDING → SUBMITTED`; accreditation
+has no equivalent lifecycle enum — only the `isVerified` boolean, which is set exclusively
+by the admin verify action. Parameterising a single slice would couple the live KYC
+payment gate to a flow that has no status transition and would require reproducing the
+`kycStatus` guard logic. Clone risk is lower than coupling risk.
+
+## isVerified vs kycStatus (C-002)
+
+`Lab.kycStatus` is the **payment-gateway KYC gate** (T-15/T-13).
+`Lab.isVerified` is the **ISO 17025 accreditation / ITA 2023 marketplace gate** (T-18).
+`confirmUpload` does **not** transition `kycStatus` and does **not** set `isVerified`.
+`isVerified` is admin-only; this slice only advances the cert `LabDocument` from
+`PENDING` to `UPLOADED`.
+
+## Two-step upload (DL-001 pattern from kyc-upload)
+
+1. `requestUploadUrl` validates MIME/size, creates a `LabDocument` row in `PENDING`, returns
+   a presigned R2 PUT URL + `labDocumentId`.
+2. The browser PUTs the file directly to R2.
+3. `confirmUpload` advances `LabDocument PENDING → UPLOADED` via `updateMany` with a
+   `{id, labId, status: 'PENDING'}` guard. `count === 0` means the doc was already confirmed
+   or the wrong lab — idempotent early-return.
+
+## LabDocument, not Attachment (DL-002)
+
+`Attachment.orderId` is `NOT NULL` (order-scoped). Accreditation is lab-level: a cert has
+no order to bind to. `LabDocument` (introduced in T-15) is already lab-scoped and reused
+for KYC. The dead `AttachmentType.ACCREDITATION_CERTIFICATE` enum value stays unwired.
+
+## documentType allowlist (C-012)
+
+`requestUploadUrl` validates `documentType` against `DOCUMENT_TYPE_ALLOWLIST`. An unknown
+value throws rather than silently inserting an unrecognised type. The allowlist mirrors the
+`documentType` field on `LabDocument` (a String column, not a Prisma enum — per DL-016 in
+`kyc-upload/README.md`).
+
+## Boundary input narrowing (DL-008)
+
+All `formData.get(…)` calls are typeof-narrowed (`typeof x === 'string' ? x : null`).
+`kyc-upload/upload-action.ts` uses `as string` coercion; `as string` masks the null case
+because `FormData.get` returns `FormDataEntryValue | null`. The canonical boundary-handling
+source for this slice is `admin/kyc-review/action.ts`. (ref: DL-008)
+
+## Orphan rows tolerated
+
+A `PENDING` `LabDocument` row is left if the client abandons after `requestUploadUrl` but
+before PUT or confirm. A future GC sweep handles both the DB row and R2 object. No cleanup
+logic belongs in this slice.
+
+## Rejection reason surfacing (DL-011)
+
+`AccreditationPageDTO` carries `accreditationRejectionReason` from `Lab`. The UI renders
+a banner when `!isVerified && accreditationRejectionReason !== null` so the lab owner knows
+what to correct before re-uploading — mirrors the T-13 M-003 lab-side banner pattern.

```


**CC-M-002-007** (src/features/labs/accreditation-upload/CLAUDE.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/labs/accreditation-upload/CLAUDE.md
@@ -0,0 +1,22 @@
+# accreditation-upload/
+
+ISO 17025 accreditation certificate upload slice for labs — presigned PUT to Cloudflare R2,
+lab-side status surfacing. Cloned from `kyc-upload/`. Does not transition `kycStatus`.
+
+## Files
+
+| File | What | When to read |
+| ---- | ---- | ------------ |
+| `upload-action.ts` | Server Action: validates MIME/size/documentType, generates presigned PUT URL, creates `LabDocument` row in `PENDING` | Modifying upload validation; debugging presigned URL errors |
+| `confirm-action.ts` | Server Action: transitions `LabDocument` `PENDING→UPLOADED` via CAS `updateMany` | Modifying the confirm step; debugging status transition bugs |
+| `page.tsx` | RSC page — reads `Lab.isVerified`, `Lab.accreditationRejectionReason`, and `LabDocument[]` for the cert; passes `AccreditationPageDTO` to `AccreditationUploadUi` | Modifying the page data shape or routing |
+| `ui.tsx` | Client component — file picker, two-step upload flow, accreditation status badge, rejection reason banner | Modifying the upload UI or badge display |
+| `README.md` | Design decisions — clone rationale, isVerified vs kycStatus, two-step flow, LabDocument vs Attachment, documentType allowlist, boundary narrowing | Understanding why the upload flow is structured this way |
+
+## Subdirectories
+
+| Directory | What | When to read |
+| --------- | ---- | ------------ |
+| `__tests__/` | Unit tests for `upload-action.ts` and `confirm-action.ts` | Adding or debugging tests for this slice |

```


**CC-M-002-008** (src/features/labs/CLAUDE.md)

**Documentation:**

```diff
--- a/src/features/labs/CLAUDE.md
+++ b/src/features/labs/CLAUDE.md
@@ -13,3 +13,4 @@ No files at this level.
 | `dashboard/` | Lab dashboard — LAB_ADMIN order listing with Incoming/Active/History tabs | Implementing or modifying the lab dashboard page |
 | `wallet/` | Lab wallet dashboard — LabWallet balances and Payout history for LAB_ADMIN | Implementing or modifying the wallet page |
 | `kyc-upload/` | KYC document upload — presigned PUT to Cloudflare R2, `Lab.kycStatus` lifecycle, checkout gate | Implementing or modifying KYC upload, checkout gate, or document list |
+| `accreditation-upload/` | ISO 17025 cert upload — presigned PUT to R2, lab-side accreditation status (`isVerified`) surfacing | Implementing or modifying accreditation upload or status display |

```


### Milestone 3: admin/accreditation-review/ slice — queue + detail + verify/reject CAS

**Files**: src/features/admin/accreditation-review/page.tsx, src/features/admin/accreditation-review/detail-page.tsx, src/features/admin/accreditation-review/action.ts, src/features/admin/accreditation-review/view-document-action.ts, src/features/admin/accreditation-review/ui.tsx, src/features/admin/accreditation-review/detail-ui.tsx, src/app/dashboard/admin/accreditation/page.tsx, src/app/dashboard/admin/accreditation/[labId]/page.tsx

**Flags**: error-handling, needs-rationale

**Requirements**:

- Queue lists labs isVerified=false owning a LabDocument {documentType:ACCREDITATION_CERTIFICATE
- status:UPLOADED} ordered createdAt asc; detail uses findUnique include owner+documents with split guards (missing row notFound
- null relation after include throws); verify=tx.lab.updateMany({where:{id
- isVerified:false}
- data:{isVerified:true
- ...audit
- accreditationRejectionReason:null}}) with count===0 early-return; reject keeps isVerified=false and records reason; doc cascade scoped to documentType=ACCREDITATION_CERTIFICATE AND status:UPLOADED only; every action re-checks role===ADMIN; presigned GET (300s) from server-trusted LabDocument.r2Key; redirect() after — not inside — the transaction; badge maps copied as const satisfies Record<DocumentStatus
- …>; RSC DTOs serialize Date->toISOString

**Acceptance Criteria**:

- An ADMIN sees pending labs in the queue; opening a lab renders a 300s presigned cert link; verifying sets isVerified=true + audit columns and cascades only the accreditation cert to VERIFIED
- leaving any KYC doc untouched; rejecting records the reason and cascades only the cert to REJECTED; a concurrent second verify observes count===0 and no-ops; a non-ADMIN POST to either action is rejected

**Tests**:

- unit (vitest)
- full Prisma mocks with method names aligned to handler calls — verify CAS count===0 early-return; reject records reason; cascade documentType-scoped (does not touch a mocked KYC doc); non-ADMIN rejected; rollback test propagates a thrown transaction error

#### Code Intent

- **CI-M-003-001** `src/features/admin/accreditation-review/page.tsx::AccreditationReviewQueuePage`: As an RSC under the admin layout, re-check role===ADMIN, then findMany labs where isVerified=false AND documents some {documentType:ACCREDITATION_CERTIFICATE, status:UPLOADED}, ordered createdAt asc. Map to a DTO serializing Date->toISOString. Renders the queue UI. (refs: DL-003, DL-007, DL-011)
- **CI-M-003-002** `src/features/admin/accreditation-review/detail-page.tsx::AccreditationReviewDetailPage`: findUnique the lab by id with include owner+documents; split guards: missing lab -> notFound(); null owner/relation after explicit include -> throw (referential-integrity violation); render detail UI. Serialize Date->toISOString. Re-check role===ADMIN. (refs: DL-007, DL-011)
- **CI-M-003-003** `src/features/admin/accreditation-review/action.ts::verifyOrRejectAccreditation`: Re-check role===ADMIN (TOCTOU). Narrow FormData inputs with typeof. In a $transaction: verify path runs tx.lab.updateMany({where:{id, isVerified:false}, data:{isVerified:true, accreditationReviewedById, accreditationReviewedAt:new Date(), accreditationRejectionReason:null}}) and early-returns on count===0; reject path runs updateMany({where:{id, isVerified:false}, data:{accreditationReviewedById, accreditationReviewedAt, accreditationRejectionReason:reason}}) leaving isVerified=false. Then cascade ONLY documentType=ACCREDITATION_CERTIFICATE AND status:UPLOADED docs to VERIFIED (verify) or REJECTED (reject) — never unscoped. Wrap the transaction in try/catch that rethrows; call redirect() AFTER the try/catch, never inside. (refs: DL-004, DL-005, DL-007, DL-012)
- **CI-M-003-004** `src/features/admin/accreditation-review/view-document-action.ts::viewAccreditationDocument`: Re-check role===ADMIN, findUnique the LabDocument by id, and return a 300s presigned GET URL derived from the server-trusted LabDocument.r2Key via generatePresignedGetUrl — never a client-supplied key (IDOR guard). (refs: DL-007, DL-011)
- **CI-M-003-005** `src/features/admin/accreditation-review/ui.tsx::AccreditationQueueUI`: Client queue table; status badge map declared as const satisfies Record over DocumentStatus, copied into this slice (no cross-slice import). (refs: DL-001)
- **CI-M-003-006** `src/features/admin/accreditation-review/detail-ui.tsx::AccreditationDetailUI`: Client detail view with the on-click presigned-GET cert link and the verify/reject form (reject requires a reason). Badge maps copied as const satisfies Record. (refs: DL-001, DL-007)
- **CI-M-003-007** `src/app/dashboard/admin/accreditation/page.tsx::default`: App-router mount re-exporting the queue page under the existing admin route-group guard. (refs: DL-007)
- **CI-M-003-008** `src/app/dashboard/admin/accreditation/[labId]/page.tsx::default`: App-router mount re-exporting the detail page for a single lab under the admin route-group guard. (refs: DL-007)

#### Code Changes

**CC-M-003-001** (src/features/admin/accreditation-review/page.tsx) - implements CI-M-003-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/accreditation-review/page.tsx
@@ -0,0 +1,57 @@
+/**
+ * Admin accreditation review queue RSC.
+ * Lists labs that are unverified (isVerified=false) AND have at least one
+ * ACCREDITATION_CERTIFICATE LabDocument with status=UPLOADED, ordered by
+ * Lab.createdAt asc (creation order, FIFO proxy — mirrors KYC queue ordering).
+ * Role check duplicated from layout.tsx: Server Actions and RSCs are independently
+ * invocable; the layout guard does not protect them. (ref: DL-001)
+ */
+import { redirect } from 'next/navigation'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { AdminAccreditationQueueUi } from './ui'
+
+export type AccreditationQueueDTO = {
+  id: string
+  name: string
+  createdAt: string
+  ownerEmail: string
+  accreditationRejectionReason: string | null
+}
+
+export default async function AdminAccreditationQueuePage() {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  const labs = await prisma.lab.findMany({
+    where: {
+      isVerified: false,
+      documents: {
+        some: {
+          documentType: 'ACCREDITATION_CERTIFICATE',
+          status: 'UPLOADED',
+        },
+      },
+    },
+    orderBy: { createdAt: 'asc' },
+    select: {
+      id: true,
+      name: true,
+      createdAt: true,
+      accreditationRejectionReason: true,
+      owner: { select: { email: true } },
+    },
+  })
+
+  const queue: AccreditationQueueDTO[] = labs.map((lab) => ({
+    id: lab.id,
+    name: lab.name,
+    createdAt: lab.createdAt.toISOString(),
+    ownerEmail: lab.owner.email,
+    accreditationRejectionReason: lab.accreditationRejectionReason,
+  }))
+
+  return <AdminAccreditationQueueUi queue={queue} />
+}
```

**Documentation:**

```diff
--- a/src/features/admin/accreditation-review/page.tsx
+++ b/src/features/admin/accreditation-review/page.tsx
@@ -1,7 +1,8 @@
 /**
  * Admin accreditation review queue RSC.
  * Lists labs that are unverified (isVerified=false) AND have at least one
  * ACCREDITATION_CERTIFICATE LabDocument with status=UPLOADED, ordered by
  * Lab.createdAt asc (creation order, FIFO proxy — mirrors KYC queue ordering).
  * Role check duplicated from layout.tsx: Server Actions and RSCs are independently
  * invocable; the layout guard does not protect them. (ref: DL-001)
+ * See README.md for full design rationale.
  */

```


**CC-M-003-002** (src/features/admin/accreditation-review/detail-page.tsx) - implements CI-M-003-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/accreditation-review/detail-page.tsx
@@ -0,0 +1,74 @@
+/**
+ * Admin accreditation detail RSC for a single lab.
+ * LabAccreditationDetailDTO carries all Date fields as .toISOString() strings.
+ * Next.js cannot serialize Prisma Date or Decimal types across the RSC boundary. (ref: DL-009)
+ * A null owner after an explicit include is a referential-integrity violation. (ref: DL-001)
+ */
+import { notFound, redirect } from 'next/navigation'
+import { type DocumentStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { AdminAccreditationDetailUi } from './detail-ui'
+
+export type LabAccreditationDetailDTO = {
+  id: string
+  name: string
+  isVerified: boolean
+  accreditationReviewedAt: string | null
+  accreditationRejectionReason: string | null
+  ownerName: string | null
+  ownerEmail: string
+  documents: {
+    id: string
+    documentType: string
+    fileName: string
+    mimeType: string
+    status: DocumentStatus
+    createdAt: string
+  }[]
+}
+
+export default async function AdminAccreditationDetailPage({
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
+      documents: {
+        where: { documentType: 'ACCREDITATION_CERTIFICATE' },
+        orderBy: { createdAt: 'desc' },
+      },
+    },
+  })
+
+  if (!lab) notFound()
+  if (!lab.owner) {
+    throw new Error('Lab.owner missing after explicit include — referential integrity violation')
+  }
+
+  const dto: LabAccreditationDetailDTO = {
+    id: lab.id,
+    name: lab.name,
+    isVerified: lab.isVerified,
+    accreditationReviewedAt: lab.accreditationReviewedAt ? lab.accreditationReviewedAt.toISOString() : null,
+    accreditationRejectionReason: lab.accreditationRejectionReason ?? null,
+    ownerName: lab.owner.name ?? null,
+    ownerEmail: lab.owner.email,
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
+  return <AdminAccreditationDetailUi dto={dto} />
+}
```

**Documentation:**

```diff
--- a/src/features/admin/accreditation-review/detail-page.tsx
+++ b/src/features/admin/accreditation-review/detail-page.tsx
@@ -1,7 +1,8 @@
 /**
  * Admin accreditation detail RSC for a single lab.
  * LabAccreditationDetailDTO carries all Date fields as .toISOString() strings.
  * Next.js cannot serialize Prisma Date or Decimal types across the RSC boundary. (ref: DL-009)
  * A null owner after an explicit include is a referential-integrity violation. (ref: DL-001)
+ * See README.md for full design rationale.
  */

```


**CC-M-003-003** (src/features/admin/accreditation-review/action.ts) - implements CI-M-003-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/accreditation-review/action.ts
@@ -0,0 +1,107 @@
+'use server'
+
+import { revalidatePath } from 'next/cache'
+import { redirect } from 'next/navigation'
+import { auth } from '@/lib/auth'
+import { prisma } from '@/lib/prisma'
+
+type ActionState = { message: string } | null
+
+/**
+ * Verifies or rejects a lab's ISO 17025 accreditation certificate.
+ *
+ * Authorization: role===ADMIN re-checked here independently of the layout guard —
+ * Server Actions are POST-invocable without navigating through any page. (ref: DL-007)
+ *
+ * State transition: CAS on isVerified=false — tx.lab.updateMany({where:{id, isVerified:false}}).
+ * count===0 means another admin already verified this lab; early-return without overwriting.
+ * A bare update() would silently clobber a concurrent verify decision. (ref: DL-004)
+ *
+ * Rejection: keeps isVerified=false, records accreditationRejectionReason, cascades
+ * ACCREDITATION_CERTIFICATE UPLOADED docs to REJECTED (documentType-scoped to avoid
+ * clobbering KYC docs coexisting in the same lab). (ref: DL-005)
+ *
+ * Document cascade is scoped to documentType=ACCREDITATION_CERTIFICATE AND status=UPLOADED
+ * because kyc-review's cascade is unscoped ({labId, status:UPLOADED}) — both must not
+ * cross-contaminate each other's documents.
+ *
+ * redirect() is called after — never inside — the transaction block. (CLAUDE.md)
+ */
+export async function verifyOrRejectAccreditation(
+  _prevState: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const labIdValue = formData.get('labId')
+  const decisionValue = formData.get('decision')
+  const reasonValue = formData.get('reason')
+  const labId = typeof labIdValue === 'string' ? labIdValue : null
+  const decision = typeof decisionValue === 'string' ? decisionValue : null
+  const reason = typeof reasonValue === 'string' ? reasonValue.trim() : ''
+
+  if (!labId) return { message: 'Missing lab ID.' }
+  if (decision !== 'VERIFIED' && decision !== 'REJECTED') {
+    return { message: 'Invalid decision.' }
+  }
+  if (decision === 'REJECTED' && !reason) {
+    return { message: 'Rejection reason is required.' }
+  }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const reviewerId = session.user.id
+
+  let result: ActionState = null
+  let shouldRedirect = false
+
+  try {
+    await prisma.$transaction(async (tx) => {
+      if (decision === 'VERIFIED') {
+        const updateResult = await tx.lab.updateMany({
+          where: { id: labId, isVerified: false },
+          data: {
+            isVerified: true,
+            accreditationReviewedById: reviewerId,
+            accreditationReviewedAt: new Date(),
+            accreditationRejectionReason: null,
+          },
+        })
+
+        if (updateResult.count === 0) {
+          result = { message: 'Lab is already verified — review may have already been recorded.' }
+          return
+        }
+
+        await tx.labDocument.updateMany({
+          where: { labId, documentType: 'ACCREDITATION_CERTIFICATE', status: 'UPLOADED' },
+          data: { status: 'VERIFIED' },
+        })
+      } else {
+        // Rejection CAS: guard isVerified===false so a reject cannot revert a lab that was
+        // concurrently verified by another admin request between the read and this write.
+        const rejectResult = await tx.lab.updateMany({
+          where: { id: labId, isVerified: false },
+          data: {
+            isVerified: false,
+            accreditationReviewedById: reviewerId,
+            accreditationReviewedAt: new Date(),
+            accreditationRejectionReason: reason,
+          },
+        })

+        if (rejectResult.count === 0) {
+          result = { message: 'Lab is already verified — rejection cannot be applied to a verified lab.' }
+          return
+        }
+
+        await tx.labDocument.updateMany({
+          where: { labId, documentType: 'ACCREDITATION_CERTIFICATE', status: 'UPLOADED' },
+          data: { status: 'REJECTED' },
+        })
+      }
+
+      shouldRedirect = true
+    })
+  } catch (e) {
+    throw new Error(`Accreditation review transaction failed: ${e instanceof Error ? e.message : String(e)}`)
+  }
+
+  if (result !== null) return result
+
+  revalidatePath('/dashboard/admin/accreditation')
+
+  if (shouldRedirect) {
+    redirect('/dashboard/admin/accreditation')
+  }
+
+  return null
+}
```

**Documentation:**

```diff
--- a/src/features/admin/accreditation-review/action.ts
+++ b/src/features/admin/accreditation-review/action.ts
@@ -1,3 +1,5 @@
 'use server'
+// Slice: admin/accreditation-review. See README.md for CAS rationale, cascade scoping,
+// and two-layer auth design.
 
 import { revalidatePath } from 'next/cache'

```


**CC-M-003-004** (src/features/admin/accreditation-review/view-document-action.ts) - implements CI-M-003-004

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/accreditation-review/view-document-action.ts
@@ -0,0 +1,48 @@
+'use server'
+
+import { auth } from '@/lib/auth'
+import { prisma } from '@/lib/prisma'
+import { generatePresignedGetUrl } from '@/lib/storage/r2'
+
+type ViewDocumentResult = { message: string } | { url: string }
+
+/**
+ * Mints a 300s presigned GET URL for a single accreditation document on admin click.
+ *
+ * The URL is not embedded in the RSC payload — it is minted on demand so each access
+ * is tied to a fresh ADMIN re-check and the credential is bounded to the 300s TTL
+ * rather than the full page lifetime. (ref: DL-004)
+ *
+ * The R2 key is loaded from the stored LabDocument row (findUnique on @unique id) —
+ * never derived from client input. generatePresignedGetUrl enforces the labs/ prefix
+ * guard as defense-in-depth. (ref: DL-004, DL-010)
+ */
+export async function viewAccreditationDocument(labDocumentId: string): Promise<ViewDocumentResult> {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  let doc: { r2Key: string } | null
+  try {
+    doc = await prisma.labDocument.findUnique({
+      where: { id: labDocumentId },
+      select: { r2Key: true },
+    })
+  } catch (e) {
+    return { message: 'Unable to retrieve document.' }
+  }
+
+  if (!doc) {
+    return { message: 'Document not found.' }
+  }
+
+  let url: string
+  try {
+    url = await generatePresignedGetUrl(doc.r2Key)
+  } catch (e) {
+    return { message: 'Unable to retrieve document.' }
+  }
+
+  return { url }
+}
```

**Documentation:**

```diff
--- a/src/features/admin/accreditation-review/view-document-action.ts
+++ b/src/features/admin/accreditation-review/view-document-action.ts
@@ -1,3 +1,4 @@
 'use server'
+// See README.md § "On-click presigned GET" for the rationale behind minting URLs on demand.
 
 import { auth } from '@/lib/auth'

```


**CC-M-003-005** (src/features/admin/accreditation-review/ui.tsx) - implements CI-M-003-005

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/accreditation-review/ui.tsx
@@ -0,0 +1,77 @@
+'use client'
+
+import Link from 'next/link'
+import type { AccreditationQueueDTO } from './page'
+
+// Status display for labs in the accreditation queue.
+// All queue entries are isVerified=false; accreditationRejectionReason non-null
+// means a prior review ended in rejection (previously rejected); null means
+// no decision has been recorded yet (awaiting first review).
+const ACCREDITATION_STATUS_BADGE = {
+  pending:  { label: 'Awaiting review', className: 'bg-yellow-200 text-yellow-800' },
+  rejected: { label: 'Previously rejected', className: 'bg-red-200 text-red-700' },
+} as const satisfies Record<'pending' | 'rejected', { label: string; className: string }>
+
+export function AdminAccreditationQueueUi({ queue }: { queue: AccreditationQueueDTO[] }) {
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
+        <div className="mb-6">
+          <h1 className="text-2xl font-bold text-gray-900">Accreditation Review Queue</h1>
+          <p className="mt-1 text-sm text-gray-500">
+            {queue.length === 0
+              ? 'No certificates awaiting review.'
+              : `${queue.length} lab${queue.length === 1 ? '' : 's'} awaiting accreditation review.`}
+          </p>
+        </div>
+
+        {queue.length > 0 && (
+          <div className="bg-white rounded-lg shadow overflow-hidden">
+            <table className="min-w-full divide-y divide-gray-200">
+              <thead className="bg-gray-50">
+                <tr>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
+                    Lab
+                  </th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
+                    Owner
+                  </th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
+                    Status
+                  </th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
+                    Registered
+                  </th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
+                    Action
+                  </th>
+                </tr>
+              </thead>
+              <tbody className="bg-white divide-y divide-gray-200">
+                {queue.map((lab) => {
+                  const badgeKey = lab.accreditationRejectionReason !== null ? 'rejected' : 'pending'
+                  const badge = ACCREDITATION_STATUS_BADGE[badgeKey]
+                  return (
+                    <tr key={lab.id}>
+                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
+                        {lab.name}
+                      </td>
+                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
+                        {lab.ownerEmail}
+                      </td>
+                      <td className="px-6 py-4 whitespace-nowrap">
+                        <span
+                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
+                        >
+                          {badge.label}
+                        </span>
+                      </td>
+                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
+                        {new Date(lab.createdAt).toLocaleDateString()}
+                      </td>
+                      <td className="px-6 py-4 whitespace-nowrap text-sm">
+                        <Link
+                          href={`/dashboard/admin/accreditation/${lab.id}`}
+                          className="text-blue-600 hover:text-blue-800 font-medium"
+                        >
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
--- a/src/features/admin/accreditation-review/ui.tsx
+++ b/src/features/admin/accreditation-review/ui.tsx
@@ -1,3 +1,5 @@
 'use client'
+// Queue UI for admin/accreditation-review. All queue entries are isVerified=false;
+// badge key derived from whether accreditationRejectionReason is non-null.
 
 import Link from 'next/link'

```


**CC-M-003-006** (src/features/admin/accreditation-review/detail-ui.tsx) - implements CI-M-003-006

**Code:**

```diff
--- /dev/null
+++ b/src/features/admin/accreditation-review/detail-ui.tsx
@@ -0,0 +1,162 @@
+'use client'
+
+import { useActionState, useTransition, useState } from 'react'
+import { type DocumentStatus } from '@prisma/client'
+import { verifyOrRejectAccreditation } from './action'
+import { viewAccreditationDocument } from './view-document-action'
+import type { LabAccreditationDetailDTO } from './detail-page'
+
+// DOC_STATUS_BADGE copied from labs/ slice — VSA prohibits cross-slice UI imports.
+// satisfies Record<DocumentStatus,…> makes a missing enum member a compile-time error. (ref: DL-009)
+const DOC_STATUS_BADGE = {
+  PENDING:  { label: 'Pending upload', className: 'bg-gray-100 text-gray-600' },
+  UPLOADED: { label: 'Uploaded',       className: 'bg-blue-100 text-blue-700' },
+  VERIFIED: { label: 'Verified',       className: 'bg-green-100 text-green-700' },
+  REJECTED: { label: 'Rejected',       className: 'bg-red-100 text-red-700' },
+} as const satisfies Record<DocumentStatus, { label: string; className: string }>
+
+/**
+ * Mints a presigned GET URL on click via viewAccreditationDocument and opens it in a new tab.
+ * URL is not pre-fetched — each click triggers a fresh Server Action call that re-checks
+ * ADMIN role and binds a new 300s TTL. (ref: DL-004)
+ */
+function ViewDocumentButton({ docId, fileName }: { docId: string; fileName: string }) {
+  const [isPending, startTransition] = useTransition()
+  const [error, setError] = useState<string | null>(null)
+
+  function handleClick() {
+    setError(null)
+    startTransition(async () => {
+      const result = await viewAccreditationDocument(docId)
+      if ('url' in result) {
+        window.open(result.url, '_blank', 'noopener,noreferrer')
+      } else {
+        setError(result.message ?? 'Unable to open document.')
+      }
+    })
+  }
+
+  return (
+    <div className="flex flex-col items-end gap-1">
+      <button
+        onClick={handleClick}
+        disabled={isPending}
+        className="text-blue-600 hover:text-blue-800 text-sm font-medium disabled:opacity-50"
+      >
+        {isPending ? 'Loading…' : `View ${fileName}`}
+      </button>
+      {error && (
+        <p className="text-xs text-red-600">{error}</p>
+      )}
+    </div>
+  )
+}
+
+export function AdminAccreditationDetailUi({ dto }: { dto: LabAccreditationDetailDTO }) {
+  const [verifyState, verifyAction, verifyPending] = useActionState(
+    verifyOrRejectAccreditation,
+    null,
+  )
+  const [rejectState, rejectAction, rejectPending] = useActionState(
+    verifyOrRejectAccreditation,
+    null,
+  )
+
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
+        <div className="mb-4">
+          <h1 className="text-2xl font-bold text-gray-900">{dto.name}</h1>
+          <p className="text-sm text-gray-500">{dto.ownerName ?? dto.ownerEmail} · {dto.ownerEmail}</p>
+          <div className="mt-2">
+            {dto.isVerified ? (
+              <span className="inline-flex items-center rounded-full px-3 py-1 text-sm font-medium bg-green-200 text-green-800">
+                Accredited
+              </span>
+            ) : (
+              <span className="inline-flex items-center rounded-full px-3 py-1 text-sm font-medium bg-yellow-200 text-yellow-800">
+                Pending review
+              </span>
+            )}
+          </div>
+        </div>
+
+        {dto.accreditationRejectionReason && (
+          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
+            <p className="text-sm font-medium text-red-800">Previous rejection reason</p>
+            <p className="text-sm text-red-700 mt-1">{dto.accreditationRejectionReason}</p>
+            {dto.accreditationReviewedAt && (
+              <p className="text-xs text-red-500 mt-1">
+                Reviewed {new Date(dto.accreditationReviewedAt).toLocaleString()}
+              </p>
+            )}
+          </div>
+        )}
+
+        {dto.documents.length > 0 && (
+          <div className="bg-white rounded-lg shadow p-4">
+            <h2 className="text-sm font-medium text-gray-700 mb-3">Accreditation Documents</h2>
+            <ul className="divide-y divide-gray-100">
+              {dto.documents.map((doc) => {
+                const db = DOC_STATUS_BADGE[doc.status]
+                return (
+                  <li key={doc.id} className="py-3 flex items-center justify-between gap-4">
+                    <div className="min-w-0">
+                      <p className="text-sm text-gray-800 truncate">{doc.fileName}</p>
+                      <p className="text-xs text-gray-500">{doc.documentType}</p>
+                    </div>
+                    <div className="flex items-center gap-3 shrink-0">
+                      <span
+                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${db.className}`}
+                      >
+                        {db.label}
+                      </span>
+                      <ViewDocumentButton docId={doc.id} fileName={doc.fileName} />
+                    </div>
+                  </li>
+                )
+              })}
+            </ul>
+          </div>
+        )}
+
+        {!dto.isVerified && (
+          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
+            <form action={verifyAction} className="bg-white rounded-lg shadow p-4">
+              <input type="hidden" name="labId" value={dto.id} />
+              <input type="hidden" name="decision" value="VERIFIED" />
+              <h3 className="text-sm font-semibold text-gray-700 mb-3">Verify Accreditation</h3>
+              {verifyState && 'message' in verifyState && verifyState.message && (
+                <p className="text-sm text-red-600 mb-2">{verifyState.message}</p>
+              )}
+              <button
+                type="submit"
+                disabled={verifyPending || rejectPending}
+                className="w-full rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
+              >
+                {verifyPending ? 'Verifying…' : 'Verify'}
+              </button>
+            </form>
+
+            <form action={rejectAction} className="bg-white rounded-lg shadow p-4">
+              <input type="hidden" name="labId" value={dto.id} />
+              <input type="hidden" name="decision" value="REJECTED" />
+              <h3 className="text-sm font-semibold text-gray-700 mb-3">Reject Certificate</h3>
+              <div className="mb-3">
+                <label className="block text-xs font-medium text-gray-600 mb-1">
+                  Reason (required)
+                </label>
+                <textarea
+                  name="reason"
+                  required
+                  rows={3}
+                  className="w-full border rounded-md px-3 py-2 text-sm"
+                  placeholder="Explain why the certificate is being rejected…"
+                />
+              </div>
+              {rejectState && 'message' in rejectState && rejectState.message && (
+                <p className="text-sm text-red-600 mb-2">{rejectState.message}</p>
+              )}
+              <button
+                type="submit"
+                disabled={verifyPending || rejectPending}
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
--- a/src/features/admin/accreditation-review/detail-ui.tsx
+++ b/src/features/admin/accreditation-review/detail-ui.tsx
@@ -0,0 +1,4 @@
+// Detail UI for admin/accreditation-review. Verify and reject forms are separate HTML
+// form elements sharing the same verifyOrRejectAccreditation action — decision is passed
+// via a hidden 'decision' input. Both forms disabled while the other is pending.
+'use client'

```


**CC-M-003-007** (src/app/dashboard/admin/accreditation/page.tsx) - implements CI-M-003-007

**Code:**

```diff
--- /dev/null
+++ b/src/app/dashboard/admin/accreditation/page.tsx
@@ -0,0 +1,2 @@
+// Route entry point. Logic lives in the feature slice (ADR-001 VSA).
+export { default } from '@/features/admin/accreditation-review/page'
```

**Documentation:**

```diff
--- a/src/app/dashboard/admin/accreditation/page.tsx
+++ b/src/app/dashboard/admin/accreditation/page.tsx
@@ -1,2 +1,3 @@
 // Route entry point. Logic lives in the feature slice (ADR-001 VSA).
+// Feature slice: src/features/admin/accreditation-review/page.tsx
 export { default } from '@/features/admin/accreditation-review/page'

```


**CC-M-003-008** (src/app/dashboard/admin/accreditation/[labId]/page.tsx) - implements CI-M-003-008

**Code:**

```diff
--- /dev/null
+++ b/src/app/dashboard/admin/accreditation/[labId]/page.tsx
@@ -0,0 +1,2 @@
+// Route entry point. Logic lives in the feature slice (ADR-001 VSA).
+export { default } from '@/features/admin/accreditation-review/detail-page'
```

**Documentation:**

```diff
--- a/src/app/dashboard/admin/accreditation/[labId]/page.tsx
+++ b/src/app/dashboard/admin/accreditation/[labId]/page.tsx
@@ -1,2 +1,3 @@
 // Route entry point. Logic lives in the feature slice (ADR-001 VSA).
+// Feature slice: src/features/admin/accreditation-review/detail-page.tsx
 export { default } from '@/features/admin/accreditation-review/detail-page'

```


**CC-M-003-009** (src/features/admin/accreditation-review/README.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/admin/accreditation-review/README.md
@@ -0,0 +1,82 @@
+# accreditation-review — Design Decisions
+
+## Slice origin — cloned from kyc-review (DL-001)
+
+This slice is a sibling clone of `admin/kyc-review/`, not a parameterised extension.
+`kyc-review/confirm-action` transitions `Lab.kycStatus` (the payment-gateway gate);
+accreditation has no equivalent status enum — only the `isVerified` boolean. Parameterising
+a single slice around `documentType` would couple the live KYC payment gate to a flow that
+has no status transition, raising regression risk. The clone gives an independent copy with
+no `kycStatus` coupling.
+
+## Two-layer auth / TOCTOU (DL-007)
+
+Every RSC page performs `auth()` and checks `session.user.role === 'ADMIN'` before data
+access. `verifyOrRejectAccreditation` re-checks the same condition at execution time —
+Server Actions are POST-invocable without navigating through any layout; the layout guard
+does not protect them.
+
+## kycStatus vs isVerified — independent lifecycles (C-002)
+
+`Lab.kycStatus` is the **payment-gateway KYC gate** (T-15/T-13).
+`Lab.isVerified` is the **ISO 17025 accreditation / marketplace-visibility gate** (T-18).
+These are independent boolean and enum lifecycles. This slice reads and writes only
+`isVerified` and the three accreditation audit columns — it never touches `kycStatus`.
+
+## Boolean CAS verify transition (DL-004)
+
+`verifyOrRejectAccreditation` writes the verified state via:
+```ts
+tx.lab.updateMany({ where: { id, isVerified: false }, data: { isVerified: true, … } })
+```
+`count === 0` means another admin already verified this lab — idempotent early-return without
+overwriting. A bare `update` cannot detect a concurrent review.
+
+The reject path guards `isVerified: false` to prevent a reject from reverting a lab that
+was concurrently verified by another admin request between the read and write.
+
+## Document cascade scoped to ACCREDITATION_CERTIFICATE (DL-005)
+
+The cascade after a verify or reject is:
+```ts
+tx.labDocument.updateMany({
+  where: { labId, documentType: 'ACCREDITATION_CERTIFICATE', status: 'UPLOADED' },
+  data: { status: 'VERIFIED' | 'REJECTED' },
+})
+```
+The `documentType` filter is mandatory. KYC docs and accreditation cert docs coexist in
+the same `LabDocument` table. An unscoped cascade (`{labId, status: 'UPLOADED'}`) in either
+slice advances documents of the other type — KYC docs getting cert status or certs getting
+KYC status. The filter prevents cross-contamination. See the corresponding note in
+`kyc-review/README.md`.
+
+## Queue filter — no accreditationStatus enum (DL-003)
+
+There is no `accreditationStatus` enum on `Lab`. The review queue derives pending state
+from labs where `isVerified: false` AND at least one `LabDocument` with
+`documentType: 'ACCREDITATION_CERTIFICATE'` and `status: 'UPLOADED'` exists. Ordered by
+`Lab.createdAt asc` (creation time FIFO proxy — mirrors the KYC queue).
+
+## On-click presigned GET (DL-004 pattern)
+
+`viewAccreditationDocument` mints a 300s presigned GET URL on demand:
+1. Re-checks `role === ADMIN`.
+2. Loads `LabDocument.r2Key` via `findUnique` on `@unique id` — never derives the key from client input.
+3. Calls `generatePresignedGetUrl(key)` — enforces the `labs/` prefix guard.
+4. Returns `{ url }` for `window.open`.
+
+Embedding URLs in the RSC payload would over-expose the credential for the full-page
+lifetime and leak it into the Next.js router cache.
+
+## Audit columns — latest-review-only (DL-009)
+
+`accreditationReviewedById`, `accreditationReviewedAt`, `accreditationRejectionReason` on
+`Lab` capture only the **latest** review. A re-review overwrites all three. Applied via
+`npx prisma db push` (dev DB is push-managed; do not run `migrate dev`).
+
+## Bootstrap — first verified lab (DL-010)
+
+No lab has `isVerified=true` post-deploy. Preferred path: a `LAB_ADMIN` uploads a cert,
+an `ADMIN` reviews it through this slice's verify flow. This exercises the real CAS path
+and leaves an audit trail via `accreditationReviewedById/At`. Fallback: see the DevOps
+checklist in `docs/roadmap.md`.

```


**CC-M-003-010** (src/features/admin/accreditation-review/CLAUDE.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/admin/accreditation-review/CLAUDE.md
@@ -0,0 +1,24 @@
+# accreditation-review/
+
+Admin ISO 17025 accreditation review slice — queue of unverified labs with a pending cert,
+per-lab detail with document viewing, and verify/reject CAS action. Cloned from `kyc-review/`.
+
+## Files
+
+| File | What | When to read |
+| ---- | ---- | ------------ |
+| `page.tsx` | RSC queue page — fetches labs where `isVerified=false` AND an UPLOADED `ACCREDITATION_CERTIFICATE` LabDocument exists; renders `AdminAccreditationQueueUi` | Modifying queue filter or ordering |
+| `detail-page.tsx` | RSC detail page — fetches a single lab with owner + accreditation docs; passes `LabAccreditationDetailDTO` to `AdminAccreditationDetailUi` | Modifying detail data shape or routing |
+| `action.ts` | `verifyOrRejectAccreditation` — ADMIN-gated server action; boolean CAS on `isVerified=false`; doc cascade scoped to `ACCREDITATION_CERTIFICATE`; redirects after transaction | Modifying verify/reject flow, CAS logic, or audit fields |
+| `view-document-action.ts` | `viewAccreditationDocument` — ADMIN-gated; loads `r2Key` from DB; returns 300s presigned GET URL | Modifying document viewing; debugging presigned URL issues |
+| `ui.tsx` | `AdminAccreditationQueueUi` — table of pending labs with Review links | Modifying the queue table layout |
+| `detail-ui.tsx` | `AdminAccreditationDetailUi` — document list with view buttons, verify form, reject form with reason textarea | Modifying the review UI or form layout |
+| `README.md` | Design decisions — clone rationale, two-layer auth, boolean CAS, scoped cascade, queue filter, on-click presigned GET | Before changing auth or state-transition logic |
+
+## Subdirectories
+
+| Directory | What | When to read |
+| --------- | ---- | ------------ |
+| `__tests__/` | Unit tests for `action.ts` | Adding or debugging tests for this slice |

```


**CC-M-003-011** (src/features/admin/CLAUDE.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/admin/CLAUDE.md
@@ -0,0 +1,15 @@
+# admin/
+
+Admin-only feature slices. All slices under this directory are protected by
+`session.user.role === 'ADMIN'` checks in both RSC pages and Server Actions (TOCTOU).
+
+## Subdirectories
+
+| Directory | What | When to read |
+| --------- | ---- | ------------ |
+| `kyc-review/` | KYC document review — queue of SUBMITTED labs, per-lab detail, approve/reject CAS on `kycStatus` | Implementing or modifying the KYC review flow |
+| `accreditation-review/` | ISO 17025 accreditation review — queue of unverified labs with an uploaded cert, verify/reject boolean CAS on `isVerified` | Implementing or modifying the accreditation review flow |

```


### Milestone 4: Marketplace read gate — services/browse filters lab.isVerified

**Files**: src/features/services/browse/page.tsx

**Flags**: needs-rationale

**Requirements**:

- labService.findMany where clause adds lab: { isVerified: true } so only services of verified labs are listed; DTO mapping unchanged otherwise

**Acceptance Criteria**:

- With no verified lab
- /services renders empty (the documented rollout state
- not a bug); after a lab is verified its active services appear; services of unverified labs never appear

**Tests**:

- unit (vitest) — ServiceBrowsePage findMany where-clause includes lab.isVerified:true so an unverified-lab service is excluded from results (browse is an independent code path from create-order/action.ts; the create-order gate test does NOT exercise this where clause
- so browse needs its own assertion); a verified-lab service is included

#### Code Intent

- **CI-M-004-001** `src/features/services/browse/page.tsx::ServiceBrowsePage`: Add lab: { isVerified: true } to the labService.findMany where clause so only services of verified labs are listed. DTO mapping is otherwise unchanged. The resulting empty /services before any lab is verified is the intended rollout state (documented in M-006), not a defect. (refs: DL-006, DL-010)

#### Code Changes

**CC-M-004-001** (src/features/services/browse/page.tsx) - implements CI-M-004-001

**Code:**

```diff
--- a/src/features/services/browse/page.tsx
+++ b/src/features/services/browse/page.tsx
@@ -29,6 +29,7 @@ export default async function ServiceBrowsePage({
   const services = await prisma.labService.findMany({
     where: {
       isActive: true,
+      lab: { isVerified: true },
       ...(activeCategory ? { category: activeCategory } : {}),
     },
     include: { lab: { select: { name: true, location: true } } },
     orderBy: { name: 'asc' },
   })
```

**Documentation:**

```diff
--- a/src/features/services/browse/page.tsx
+++ b/src/features/services/browse/page.tsx
@@ -29,6 +29,8 @@ export default async function ServiceBrowsePage({
   const services = await prisma.labService.findMany({
     where: {
       isActive: true,
+      // ITA 2023 marketplace gate: hide services from labs that have not completed
+      // ISO 17025 accreditation review. Security-critical write gate lives in
+      // create-order/action.ts — this filter is the UX layer on top. (ref: DL-006)
       lab: { isVerified: true },

```


### Milestone 5: create-order write gate (security-critical) — server-side reject unverified lab

**Files**: ["src/features/orders/create-order/action.ts", "src/features/orders/create-order/page.tsx", "src/features/orders/create-order/__tests__/accreditation-gate.test.ts"]

**Flags**: error-handling, needs-rationale

**Requirements**:

- create-order re-fetch of labService.findUnique adds include lab:{select:{isVerified:true}}; after the existing !service guard
- reject with a message when service.lab.isVerified===false BEFORE the $transaction; serviceId boundary input typeof-narrowed; page.tsx optionally surfaces unverified state but the server reject is the control

**Acceptance Criteria**:

- POSTing a serviceId whose lab.isVerified=false returns a rejection and creates no Order/Transaction; a verified lab order proceeds unchanged; the reject occurs before any transactional write

**Tests**:

- unit (vitest) mirroring checkout kyc-gate.test.ts — unverified lab serviceId rejected with no Order created; verified lab proceeds

#### Code Intent

- **CI-M-005-001** `src/features/orders/create-order/action.ts::createOrder`: Narrow serviceId with typeof (replace the as string cast). On the TOCTOU re-fetch, add include lab:{select:{isVerified:true}} to labService.findUnique. After the existing !service guard and before the $transaction, reject with a user-facing message when service.lab.isVerified===false. This server-side reject is the ITA-2023 solidary-liability control; UI hiding alone is insufficient because a client can POST a serviceId directly. (refs: DL-006, DL-008, DL-012)
- **CI-M-005-002** `src/features/orders/create-order/page.tsx::CreateOrderPage`: Optionally surface that the lab is unverified for UX, but treat the server-side action reject as the authoritative control. No client gate is relied upon. (refs: DL-006)

#### Code Changes

**CC-M-005-001** (src/features/orders/create-order/action.ts) - implements CI-M-005-001

**Code:**

```diff
--- a/src/features/orders/create-order/action.ts
+++ b/src/features/orders/create-order/action.ts
@@ -18,8 +18,11 @@ export async function createOrder(
   _prevState: ActionState,
   formData: FormData,
 ): Promise<ActionState> {
-  const serviceId = formData.get('serviceId') as string | null
+  const serviceIdValue = formData.get('serviceId')
+  const serviceId = typeof serviceIdValue === 'string' ? serviceIdValue : null
   if (!serviceId) return { message: 'Missing service ID.' }
 
   // Re-fetch from DB — do not trust any pricingMode value from the client (TOCTOU guard)
   const service = await prisma.labService.findUnique({
-    where: { id: serviceId, isActive: true },
+    where: { id: serviceId, isActive: true },
+    include: { lab: { select: { isVerified: true } } },
   })
   if (!service) return { message: 'Service no longer available.' }
+  if (!service.lab.isVerified) return { message: 'This service is not currently available — the lab has not completed accreditation.' }
 
   const session = await auth()
```

**Documentation:**

```diff
--- a/src/features/orders/create-order/action.ts
+++ b/src/features/orders/create-order/action.ts
@@ -18,6 +18,10 @@ export async function createOrder(
   _prevState: ActionState,
   formData: FormData,
 ): Promise<ActionState> {
+  // FormData.get types serviceId as unknown; narrow before trusting. (ref: DL-008)
   const serviceIdValue = formData.get('serviceId')
   const serviceId = typeof serviceIdValue === 'string' ? serviceIdValue : null
   if (!serviceId) return { message: 'Missing service ID.' }
@@ -26,6 +30,9 @@ export async function createOrder(
   const service = await prisma.labService.findUnique({
     where: { id: serviceId, isActive: true },
     include: { lab: { select: { isVerified: true } } },
   })
   if (!service) return { message: 'Service no longer available.' }
+  // ITA 2023 solidary-liability gate: reject server-side before any DB write.
+  // The /services browse filter is the UX layer; a client can POST serviceId directly
+  // to this action without navigating through the marketplace. (ref: DL-006)
   if (!service.lab.isVerified) return { message: 'This service is not currently available — the lab has not completed accreditation.' }

```


**CC-M-005-002** (src/features/orders/create-order/page.tsx) - implements CI-M-005-002

**Code:**

```diff
--- a/src/features/orders/create-order/page.tsx
+++ b/src/features/orders/create-order/page.tsx
@@ -10,6 +10,7 @@ export type CreateOrderServiceDTO = {
   pricingMode: 'QUOTE_REQUIRED' | 'FIXED' | 'HYBRID'
   pricePerUnit: string | null
   unit: string | null
+  labIsVerified: boolean
   lab: {
     name: string
     location: Record<string, unknown> | null
     certifications: string[]
   }
 }
@@ -30,7 +31,7 @@ export default async function CreateOrderPage({
   const service = await prisma.labService.findUnique({
     where: { id: params.serviceId, isActive: true },
-    include: { lab: { select: { name: true, location: true, certifications: true } } },
+    include: { lab: { select: { name: true, location: true, certifications: true, isVerified: true } } },
   })
   if (!service) notFound()
 
@@ -40,6 +41,7 @@ export default async function CreateOrderPage({
     pricePerUnit: service.pricePerUnit?.toFixed(2) ?? null,
     unit: service.unit,
+    labIsVerified: service.lab.isVerified,
     lab: {
       name: service.lab.name,
       location: service.lab.location as Record<string, unknown> | null,
       certifications: service.lab.certifications,
     },
   }
```

**Documentation:**

```diff
--- a/src/features/orders/create-order/page.tsx
+++ b/src/features/orders/create-order/page.tsx
@@ -10,6 +10,8 @@ export type CreateOrderServiceDTO = {
   pricingMode: 'QUOTE_REQUIRED' | 'FIXED' | 'HYBRID'
   pricePerUnit: string | null
   unit: string | null
+  // Carried in the DTO so the page can surface an accreditation-not-verified warning
+  // without a second DB hit. The authoritative gate is the server action. (ref: DL-006)
   labIsVerified: boolean

```


**CC-M-005-003** (src/features/orders/create-order/__tests__/accreditation-gate.test.ts)

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/create-order/__tests__/accreditation-gate.test.ts
@@ -0,0 +1,110 @@
+/**
+ * Unit tests for the accreditation gate in createOrder.
+ * Verifies that labs with isVerified===false are rejected before any Order is written.
+ */
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+import { PricingMode } from '@prisma/client'
+
+const mocks = vi.hoisted(() => ({
+  labServiceFindUnique: vi.fn(),
+  orderCreate: vi.fn(),
+  clientProfileCreate: vi.fn(),
+  $transaction: vi.fn(),
+  auth: vi.fn(),
+  redirect: vi.fn(),
+  resolveOrderInitialState: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    labService: { findUnique: mocks.labServiceFindUnique },
+    $transaction: mocks.$transaction,
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({
+  auth: mocks.auth,
+}))
+
+vi.mock('next/navigation', () => ({
+  redirect: mocks.redirect,
+}))
+
+vi.mock('@/domain/orders/pricing', () => ({
+  resolveOrderInitialState: mocks.resolveOrderInitialState,
+}))
+
+vi.mock('@/domain/orders/client-details', () => ({
+  clientDetailsSchema: {
+    safeParse: vi.fn().mockReturnValue({
+      success: true,
+      data: {
+        name: 'Test Client',
+        email: 'client@example.com',
+        phone: '+63 912 345 6789',
+        organization: undefined,
+        address: undefined,
+      },
+    }),
+  },
+}))
+
+import { createOrder } from '../action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const CLIENT_SESSION = {
+  user: { id: 'client-user-id', role: 'CLIENT' },
+  expires: '2099-01-01',
+}
+
+function makeService(isVerified: boolean) {
+  return {
+    id: 'service-1',
+    labId: 'lab-1',
+    isActive: true,
+    pricingMode: PricingMode.FIXED,
+    pricePerUnit: 500,
+    lab: { isVerified },
+  }
+}
+
+function makeFormData(): FormData {
+  const fd = new FormData()
+  fd.append('serviceId', 'service-1')
+  fd.append('name', 'Test Client')
+  fd.append('email', 'client@example.com')
+  fd.append('phone', '+63 912 345 6789')
+  fd.append('sampleDescription', 'Blood sample')
+  fd.append('consentGiven', 'true')
+  return fd
+}
+
+describe('createOrder — accreditation gate', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mockAuth.mockResolvedValue(CLIENT_SESSION)
+    mocks.redirect.mockImplementation(() => {
+      throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT' })
+    })
+    mocks.resolveOrderInitialState.mockReturnValue({
+      status: 'QUOTE_REQUESTED',
+      quotedPrice: null,
+      quotedAt: null,
+    })
+    mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
+      fn({
+        order: { create: mocks.orderCreate },
+        clientProfile: { create: mocks.clientProfileCreate },
+      }),
+    )
+    mocks.orderCreate.mockResolvedValue({ id: 'order-1', status: 'QUOTE_REQUESTED' })
+    mocks.clientProfileCreate.mockResolvedValue({})
+  })
+
+  it('isVerified===false — returns rejection message, no Order created', async () => {
+    mocks.labServiceFindUnique.mockResolvedValue(makeService(false))
+
+    const result = await createOrder(null, makeFormData())
+
+    expect(result).toEqual({
+      message: 'This service is not currently available — the lab has not completed accreditation.',
+    })
+    expect(mocks.$transaction).not.toHaveBeenCalled()
+  })
+
+  it('isVerified===true — proceeds to create order without accreditation rejection', async () => {
+    mocks.labServiceFindUnique.mockResolvedValue(makeService(true))
+
+    const result = await createOrder(null, makeFormData())
+
+    expect(mocks.$transaction).toHaveBeenCalledTimes(1)
+    expect(result).not.toEqual(
+      expect.objectContaining({
+        message: expect.stringContaining('accreditation'),
+      }),
+    )
+  })
+
+  it('service not found — returns service unavailable, no accreditation check runs', async () => {
+    mocks.labServiceFindUnique.mockResolvedValue(null)
+
+    const result = await createOrder(null, makeFormData())
+
+    expect(result).toEqual({ message: 'Service no longer available.' })
+    expect(mocks.$transaction).not.toHaveBeenCalled()
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/orders/create-order/__tests__/accreditation-gate.test.ts
+++ b/src/features/orders/create-order/__tests__/accreditation-gate.test.ts
@@ -1,5 +1,6 @@
 /**
  * Unit tests for the accreditation gate in createOrder.
  * Verifies that labs with isVerified===false are rejected before any Order is written.
  */

```


### Milestone 6: DevOps rollout + docs — first-verified-lab bootstrap checklist

**Files**: docs/roadmap.md

**Flags**: needs-rationale

**Requirements**:

- Add an Infrastructure & DevOps Provisioning checklist entry (DL-008 style) alongside the T-13 first-admin bootstrap: preferred path = self-review one lab's ACCREDITATION_CERTIFICATE through /dashboard/admin/accreditation immediately post-deploy (exercises the real verify CAS + leaves an audit trail via accreditationReviewedById/At); fallback = manual UPDATE labs SET isVerified=true WHERE id=<lab-id> per-environment (gitignored-migration-style); add the T-18 audit-columns per-env db push note mirroring the T-13 audit-columns entry; note the empty /services pre-bootstrap is intentional|This milestone OWNS the R-002 follow-up: add a tracked deferral note to src/features/admin/kyc-review/README.md (and the roadmap follow-up list) stating that kyc-review/action.ts's currently-unscoped UPLOADED cascade MUST be documentType-scoped before any second non-KYC LabDocument type can be reviewed through that slice — T-18 scopes only the new accreditation cascade (M-003); retro-scoping the shipped KYC cascade is explicitly deferred here
- not silently dropped

**Acceptance Criteria**:

- docs/roadmap.md Infrastructure & DevOps Provisioning section contains a first-verified-lab entry with preferred (admin self-review) + fallback (manual UPDATE) paths and a T-18 audit-columns db-push entry
- consistent in format with the existing first-admin DL-008 entry

**Tests**:

- none — documentation milestone (no executable behavior; the R-002 kyc-review retro-scoping is a deferred written follow-up
- not code in this ticket)

#### Code Intent

- **CI-M-006-001** `docs/roadmap.md::Infrastructure & DevOps Provisioning`: Add a first-verified-lab bootstrap checklist entry consistent with the T-13 first-admin DL-008 entry: PREFERRED = self-review one lab ACCREDITATION_CERTIFICATE through /dashboard/admin/accreditation immediately post-deploy (exercises the real verify CAS and leaves an audit trail via accreditationReviewedById/At); FALLBACK = manual per-environment UPDATE labs SET isVerified=true WHERE id=<lab-id> (gitignored-migration-style). Add a T-18 audit-columns per-environment entry mirroring the T-13 audit-columns line: apply via prisma db push on each Neon branch after pulling T-18 (migrations gitignored, schema.prisma is source of truth). Note that an empty /services before the first lab is verified is the intended gated state, not a bug. (refs: DL-009, DL-010)
- **CI-M-006-002** `src/features/admin/kyc-review/README.md::Cascade-scoping deferral note`: Add a tracked follow-up note documenting that kyc-review/action.ts's UPLOADED doc cascade is currently unscoped ({labId, status:UPLOADED}) and is safe ONLY while a lab has no non-KYC LabDocument. T-18 introduces accreditation LabDocuments but scopes ONLY its own cascade (M-003 / DL-005); the shipped KYC cascade is NOT retro-scoped in T-18. State explicitly that before any future review path advances a second non-KYC document type through kyc-review, that cascade MUST be narrowed to documentType-scoped to avoid clobbering accreditation (or other) UPLOADED docs. This makes the R-002 cross-domain-clobber follow-up an explicitly deferred, owned item rather than a silent gap. (refs: DL-005)

#### Code Changes

**CC-M-006-001** (docs/roadmap.md) - implements CI-M-006-001

**Code:**

```diff
--- a/docs/roadmap.md
+++ b/docs/roadmap.md
@@ -169,6 +169,8 @@ Checklist of everything that must be provisioned outside the codebase for the pl
 - [ ] **T-13 audit columns applied per-environment** — `prisma/migrations/` is gitignored (DL-011); run `npx prisma migrate dev` locally and on each Neon branch after pulling T-13. `schema.prisma` is the committed source of truth; missing this step causes a runtime crash on the audit fields, not a type error.
+- [ ] **T-18 accreditation audit columns applied per-environment** — `accreditationReviewedById`, `accreditationReviewedAt`, `accreditationRejectionReason` added to `Lab` in T-18. Apply via `npx prisma db push` (dev DB is push-managed; do not run `migrate dev`). Missing this step causes a runtime crash on the audit fields.
+- [ ] **First verified lab bootstrapped** — the marketplace is empty until at least one lab has `isVerified=true`. Preferred path: a LAB_ADMIN uploads an ISO 17025 cert at `/dashboard/lab/accreditation`, then an ADMIN reviews it at `/dashboard/admin/accreditation` and verifies through the UI. This exercises the real CAS path and leaves an audit trail via `accreditationReviewedById`/`At`. Fallback (no cert available): `UPDATE "labs" SET "isVerified" = true, "accreditationReviewedAt" = now() WHERE id = '<lab-id>';`
 - [ ] **First ADMIN user bootstrapped** — `UPDATE "users" SET role = 'ADMIN' WHERE email = '<admin-email>';` on the target Neon branch (DL-008). No in-app promotion path exists.
```

**Documentation:**

```diff
--- a/docs/roadmap.md
+++ b/docs/roadmap.md
@@ -169,6 +169,9 @@ Checklist of everything that must be provisioned outside the codebase for the pl
-~~- [ ] **T-13 audit columns applied per-environment** — run `npx prisma migrate dev` (see correction below)~~
+- [ ] **T-13 audit columns applied per-environment** — `prisma/migrations/` is gitignored (DL-011); apply via `npx prisma db push` on the Neon dev branch (dev DB is push-managed; `migrate dev` would drift/reset). `schema.prisma` is the committed source of truth; missing this step causes a runtime crash on the audit fields, not a type error.
 - [ ] **T-18 accreditation audit columns applied per-environment** — `accreditationReviewedById`, `accreditationReviewedAt`, `accreditationRejectionReason` added to `Lab` in T-18. Apply via `npx prisma db push` (dev DB is push-managed; `migrate dev` would drift/reset the Neon branch). Missing this step causes a runtime crash on the audit fields.
- [ ] **First verified lab bootstrapped** — the marketplace is empty until at least one lab has `isVerified=true`. Preferred path: a LAB_ADMIN uploads an ISO 17025 cert at `/dashboard/lab/accreditation`, then an ADMIN reviews it at `/dashboard/admin/accreditation` and verifies through the UI. Fallback: `UPDATE "labs" SET "isVerified" = true, "accreditationReviewedAt" = now() WHERE id = '<lab-id>';`

```


**CC-M-006-002** (src/features/admin/kyc-review/README.md) - implements CI-M-006-002

**Code:**

```diff
/tmp/fix-cc-m-006-002-diff.diff
```

**Documentation:**

```diff
--- a/src/features/admin/kyc-review/README.md
+++ b/src/features/admin/kyc-review/README.md
@@ -89,7 +89,9 @@ Any in-app promotion path is a chicken-and-egg trust hole (who authorizes the fi
 Self-service role management is spun out as T-13b. See the DevOps checklist in
 `docs/roadmap.md` for the required apply command.

 ## Migrations not committed (DL-011)

 `prisma/migrations/` is gitignored. The Lab audit columns (`kycReviewedById`,
 `kycReviewedAt`, `kycRejectionReason`, reviewer relation) are applied per-environment via
-`npx prisma migrate dev`. `schema.prisma` is the committed source of truth. A fresh or CI
+`npx prisma db push` (dev DB is push-managed; see devops-discipline.md). `schema.prisma` is the committed source of truth. A fresh or CI
 environment missing this step gets a runtime crash on the audit fields, not a type error.
 See the DevOps checklist in `docs/roadmap.md` for the required apply command.
+
+## Unscoped doc cascade — safe as long as only KYC docs exist per lab
+
+`approveOrRejectKyc` cascades UPLOADED documents via `{labId, status: 'UPLOADED'}` with no
+`documentType` filter. This is safe as long as a lab's only LabDocuments are KYC docs.
+ACCREDITATION_CERTIFICATE LabDocuments coexist in the same table. The accreditation-review
+cascade is scoped (`{labId, documentType: 'ACCREDITATION_CERTIFICATE', status: 'UPLOADED'}`),
+so it does not advance KYC docs. However, if this KYC cascade runs while an accreditation
+cert is in UPLOADED state, it will advance that cert to VERIFIED/REJECTED alongside the
+KYC docs — potentially incorrect. Scope this cascade to `documentType` IN KYC types before
+T-12 (attachment uploads) introduces further LabDocument variety.

```


**CC-M-006-003** (src/features/CLAUDE.md)

**Documentation:**

```diff
--- a/src/features/CLAUDE.md
+++ b/src/features/CLAUDE.md
@@ -13,4 +13,4 @@ Vertical slice features. Each subdirectory is a self-contained slice with its ow
 | `services/`| Lab service listing and detail slices      | Implementing service browsing or search           |
 | `clients/` | Client-facing feature slices               | Implementing client dashboard or order views      |
-| `admin/`   | Admin-only feature slices                  | Implementing any admin operation (KYC review, future role management) |
+| `admin/`   | Admin-only feature slices                  | Implementing any admin operation (KYC review, accreditation review, future role management) |

```


## Execution Waves

- W-001: M-001
- W-002: M-002, M-003, M-004, M-005
- W-003: M-006
