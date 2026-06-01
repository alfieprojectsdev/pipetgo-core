# Plan

## Overview

Labs cannot upload KYC documents, and the platform cannot prevent unverified labs from receiving payments at checkout. Attachment.orderId is NOT NULL so it cannot store lab-level documents. Lab.isVerified is reserved for T-18 ISO 17025 accreditation — a separate regulatory concern from payment-gateway KYC. Without a dedicated lab-level document store and a checkout-time gate, every PAYMENT_PENDING order from any lab proceeds to Xendit invoice creation regardless of verification state — a business invariant violation, because PipetGo commits to settle into the lab's account during settlement and the platform has no leverage to halt the flow once the invoice is paid.

**Approach**: Add KycStatus enum (PENDING, SUBMITTED, APPROVED, REJECTED), Lab.kycStatus field (default PENDING, separate from Lab.isVerified), and a new LabDocument model keyed on labId only (no Order FK). Provision @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner and a new src/lib/storage/r2.ts client that signs short-lived PUT URLs (300 s) scoped to keys of the form labs/{labId}/{cuid}.{ext}; the client uploads directly to R2, bypassing Next.js 4.5 MB FormData. A new VSA slice at src/features/labs/kyc-upload/ exposes a Server Action that validates MIME + size, generates the presigned URL, and writes a LabDocument row with status PENDING; a confirm action transitions the row to UPLOADED and updates Lab.kycStatus to SUBMITTED. Xendit business-verification submission is skipped entirely — manual admin verification (UI in T-13) flips kycStatus from SUBMITTED to APPROVED. Both initiateCheckout (invoice) and initiateVaCheckout (FVA) gate on Lab.kycStatus === APPROVED before the Xendit call. T-10 settlement handler stays untouched. AbortSignal.timeout(10_000) on every external fetch; unhandled enum branches throw; redirect() remains terminal outside try/catch; KycStatus dispatch tables use as const satisfies Record<KycStatus, …>.

### T-15 upload flow + checkout gate

[Diagram pending Technical Writer rendering: DIAG-001]

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Introduce a new LabDocument model rather than make Attachment.orderId nullable | Attachment.orderId is NOT NULL and uploadedById, labId are required — KYC docs have no order context -> making orderId nullable pollutes every existing Attachment query with a nullable FK that callers must defensively handle and risks accidental fan-out across unrelated rows when a future joiner forgets the filter -> a dedicated LabDocument keyed on labId only is a strictly additive change with no migration risk on existing Attachment rows and a clearer single-purpose model for lab-level documents (KYC today, ISO 17025 later via T-18 if needed) |
| DL-002 | Add Lab.kycStatus KycStatus field (PENDING|SUBMITTED|APPROVED|REJECTED) — keep Lab.isVerified untouched, reserved for T-18 ISO 17025 | Lab.isVerified is reserved for T-18 ISO 17025 accreditation — a regulatory artifact distinct from payment-gateway KYC -> conflating the two collapses two independent verification lifecycles into a single boolean that cannot represent SUBMITTED-awaiting-review or REJECTED states -> a separate KycStatus enum default PENDING preserves T-18 invariant and gives T-15 the four-state lifecycle the manual-admin verification path (T-13) needs |
| DL-003 | Gate both initiateCheckout (invoice) and initiateVaCheckout (FVA) on Lab.kycStatus === APPROVED — never the T-10 settlement handler | By settlement time Xendit has already collected client funds and the platform owes the lab — gating there cannot stop payment, only delay payout, which is a worse customer experience and still leaves the funds-collected state -> the checkout actions are the first point where the platform commits to creating a Xendit invoice/FVA in the lab's name; rejecting before that call is the only place where no money has moved -> placing the gate inside both checkout actions covers both invoice and FVA paths via one lookup of Order.lab.kycStatus; the gate returns a user-visible ActionState error (never throws, never silently advances), matching the existing PAYMENT_PENDING / quotedPrice guards |
| DL-004 | Defer Xendit business-verification API submission entirely — manual admin verification (T-13) flips SUBMITTED to APPROVED | Xendit business-verification endpoint shape is M-confidence (docs confirm the concept exists but exact payload, document handling, and webhook semantics are unverified) -> wiring an unverified external API on the critical KYC path risks shipping a slice that fails in sandbox and blocks every lab onboarding until the integration is debugged -> manual admin verification has zero external-API risk, ships faster, and keeps Xendit integration optional for a future ticket once the endpoint is verified; the SUBMITTED -> APPROVED transition is the admin UI's responsibility in T-13 and does not require new payment-provider code in this slice |
| DL-005 | Presigned PUT URL pattern with TTL 300 s; client uploads directly to R2 | Next.js Server Action FormData has a hard 4.5 MB cap on Vercel; KYC docs target up to 20 MB (PDF/JPG/PNG for BIR 2303, DTI/SEC registration) -> server-side streaming through a Server Action does not work past the 4.5 MB limit on Vercel runtime -> presigned PUT URL signed by the Server Action lets the browser PUT directly to R2 with no Next.js bottleneck; a 300 s TTL bounds the window in which a leaked URL is exploitable while still accommodating slow mobile uploads |
| DL-006 | R2 object key shape: labs/{labId}/{cuid}.{ext} — generated server-side; client never supplies the key | If the client supplied the key, a malicious LAB_ADMIN could PUT into labs/<other-lab>/... and cross-contaminate or shadow another lab document set -> the Server Action validates the caller is the lab owner (Lab.ownerId === session.user.id) and constructs the key from session-derived labId + a server-generated cuid -> the key is then bound to the LabDocument row at creation, so even if a URL leaks the only valid object it can write is the one corresponding to the LabDocument row already created with that key |
| DL-007 | LabDocument has its own DocumentStatus enum (PENDING|UPLOADED|VERIFIED|REJECTED) — distinct from Lab.kycStatus | Lab.kycStatus aggregates the lab-wide verification state; individual document rows have their own lifecycle (presigned URL created -> client uploaded -> admin reviewed/rejected) -> collapsing per-document state into Lab.kycStatus would require composite logic on every read (count of UPLOADED rows, count of REJECTED rows) and break the principle that each entity owns its own status field -> a separate DocumentStatus enum on LabDocument gives each row a single canonical state and lets Lab.kycStatus remain a simple lab-wide rollup that the manual admin tool (T-13) writes directly |
| DL-008 | MIME and size validation enforced server-side at the upload-action — application/pdf, image/jpeg, image/png; max 20 MB | Trusting client-reported MIME/size is exploitable (the browser can lie about Content-Type and Content-Length) -> the Server Action validates the declared MIME against an allowlist and the declared size against the 20 MB ceiling before signing the URL; the R2 client also binds Content-Type into the signed PUT so the actual upload Content-Type header must match the value signed -> belt-and-suspenders: action rejects out-of-policy values before signing; signed URL rejects mismatched Content-Type at PUT time |
| DL-009 | R2 client (src/lib/storage/r2.ts) lives in src/lib/storage/, not src/lib/payments/ | src/lib/payments/ is for payment-provider clients (Xendit, future Stripe/PayMongo); R2 is object storage and shares no abstraction with payment providers -> placing r2.ts under src/lib/payments/ would mis-categorize the dependency surface and force future storage clients (e.g. a thumbnail bucket) into the payments namespace -> src/lib/storage/ is the correct namespace; this slice is the first occupant and the directory may be created |
| DL-010 | Confirm action transitions LabDocument PENDING -> UPLOADED inside a Prisma $transaction that also writes Lab.kycStatus = SUBMITTED when the lab has at least one UPLOADED document | Two writes (document status, lab status) must succeed together or neither — otherwise a successful confirm can leave the document marked UPLOADED but the lab still PENDING (or vice versa) -> wrapping both in a single $transaction makes the transition atomic and idempotent: if the document is already UPLOADED the confirm is a no-op; if Lab.kycStatus is already SUBMITTED the lab write is a no-op -> the kycStatus update uses an updateMany guard predicate (status: PENDING) to follow the Implementation Discipline rule that webhook/state-transition writes must guard against concurrent advancement |
| DL-011 | KYC gate placed at the top of each checkout action — immediately after the existing PAYMENT_PENDING / quotedPrice guards, before the PENDING-Transaction idempotency lookup; gate intentionally preempts the redirect-to-existing-PENDING-Transaction branch | The gate must run before any Xendit invoice/FVA creation but must not preempt the order-validity guards (order not found, wrong status, missing quotedPrice produce more specific error messages than wrong KYC state) -> placing it after the order guards keeps user-facing error messages specific -> placing it before the PENDING-Transaction idempotency lookup ensures even a doubly-submitted form for an unverified lab never reaches Xendit; the redirect-to-existing-PENDING-Transaction branch is deliberately preempted because any pre-existing PENDING Transaction on an unverified lab is one of two cases: (i) pre-T15 fixture where KycStatus did not exist at creation time — preempting the redirect is intentional cleanup, the user gets a clear 'lab not verified' error instead of being silently redirected to a defunct invoice; (ii) post-T15 race where Lab.kycStatus was downgraded between checkout attempts (not yet possible since this slice only writes PENDING->SUBMITTED, and T-13 will only write SUBMITTED->APPROVED|REJECTED) — also benign, the error message remains correct -> in both cases the user-visible outcome (an explicit error string at the resubmit) is strictly better than the alternative (silent redirect to a Xendit invoice the lab cannot collect on); migration risk: dev DB may contain pre-T15 PENDING Transactions whose related labs default to KycStatus.PENDING after migration — operators should not be surprised when an in-flight checkout returns the KYC error after deploy; documented in PR description |
| DL-012 | KycStatus badge UI uses const STATUS_BADGE = {...} as const satisfies Record<KycStatus, {label,className}> | Per Implementation Discipline, enum dispatch tables must use as const satisfies Record<EnumType, …> — Record<string, …> with a ?? fallback would silently render the wrong badge when a new enum member is added later -> the satisfies clause makes a missing entry a compile-time error so any future KycStatus extension fails npx tsc --noEmit until the badge map is updated -> consistent with the canonical example at src/features/labs/wallet/ui.tsx (STATUS_BADGE for PayoutStatus) |
| DL-013 | Tests: unit-only — r2.test.ts (mock S3 presigner, assert allowlist + size rejections), upload-action.test.ts (mock Prisma + r2, assert key shape and document row creation), confirm-action.test.ts (mock Prisma, assert atomic transition + idempotency), checkout-action.kyc-gate.test.ts (mock Prisma, assert both initiateCheckout and initiateVaCheckout return KYC error when kycStatus !== APPROVED) | No integration or E2E tests are in scope for this ticket — the slice is greenfield and the storage layer is mocked at the SDK boundary (S3Client) -> the four unit suites lock the four behavioural invariants: signing allowlist, key shape, transition atomicity, gate completeness across both checkout paths -> follows the project pattern (T-17, T-14, T-20 all unit-only) |
| DL-014 | prisma/migrations/ stays gitignored — migration applied locally with npx prisma migrate dev --name add-lab-kyc-status; PR commits only schema.prisma | Established repo convention from T-16, T-17, T-20 — prisma/migrations/ is gitignored and migrations are derived from schema state -> committing migration files would diverge from convention and produce a noisy diff -> local migrate dev applies the schema to the dev DB before npm test -- --run so testPrisma sees the new columns/models |
| DL-015 | Add @unique to Lab.ownerId in this slice — one-lab-per-owner is a runtime invariant already enforced by src/features/labs/onboarding/action.ts | src/features/labs/onboarding/action.ts already runtime-guards lab.findFirst({where:{ownerId}}) and returns an error if a lab exists for the user -> the @unique index promotes that app-level guard into a schema-level invariant, making prisma.lab.findUnique({where:{ownerId}}) the correct lookup everywhere and eliminating the findFirst+@@index({ownerId}) pattern that silently picks an arbitrary row if the invariant is ever violated -> aligns with the Implementation Discipline rule that Prisma lookups on uniqueness invariants must use findUnique; closes the temporal contamination in upload-action.ts (no forward-dated TODO needed) and lets all three call sites (upload-action, confirm-action, page) move to findUnique now |
| DL-016 | documentType is a free-form String column with a server-side allowlist (BIR_2303, DTI_SEC, OTHER) — not a Prisma enum | The Philippine KYC document set is regulator-driven and will accrete over time (likely additions: MAYORS_PERMIT, BSP_CERT, BARANGAY_CLEARANCE) -> a Prisma enum forces a schema migration for every new document kind, whereas a String column with a typed allowlist constant lets the catalog evolve in src/features/labs/kyc-upload/ without schema drift -> server-side validation against the constant is the same safety guarantee an enum gives at the DB boundary (rejects unknown values before write); the OTHER bucket also lets labs upload ad-hoc supporting docs without code changes. The starting allowlist [BIR_2303, DTI_SEC, OTHER] covers the universal-required PH business docs and the escape hatch |
| DL-017 | Drop generatePresignedGetUrl from the M-001 R2 module — KYC docs are never re-served to clients in T-15 | No code_intent in this slice calls generatePresignedGetUrl: the lab dashboard surfaces the document list (file name, type, status, createdAt) but not the file contents, and the manual admin verification UI is T-13 -> a 3600 s GET TTL with no caller is dead code that ages and risks being copy-pasted with the wrong TTL later -> drop the function from r2.ts now; add it back in T-13 when the admin review UI actually needs to display the docs, with the TTL chosen and DL-backed at that point |
| DL-018 | Orphan R2 objects (PUT succeeded but confirmUpload never fired) are tolerated cost in T-15 — paired with orphan LabDocument DB rows under the same future GC ticket | The two-step upload flow can leave three states after abandonment: (a) PENDING LabDocument row + no R2 object (URL signed but never PUT), (b) PENDING LabDocument row + R2 object (PUT succeeded, confirm never fired), (c) no LabDocument row + R2 object (impossible — row is created before signing) -> cases (a) and (b) both leave a PENDING row, so the GC sweep keys on LabDocument.status === PENDING AND createdAt < now - 24h and for each such row issues both a DB delete AND an R2 DeleteObject by r2Key — one ticket covers both orphan classes -> R2 free tier easily absorbs the storage cost (KYC docs are ≤20 MB and abandonment rate is expected to be <5%); no engineering risk for MVP, future ticket linked from src/features/labs/kyc-upload/CLAUDE.md |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Make Attachment.orderId nullable and reuse Attachment for KYC docs | Nullable FK pollutes every existing Attachment query with defensive null handling; risks accidental fan-out across unrelated rows; migration changes shape of an in-use table for an out-of-scope concern. (ref: DL-001) |
| Reuse Lab.isVerified as the KYC flag | Lab.isVerified is reserved for T-18 ISO 17025 accreditation; conflating two distinct verification regimes collapses two lifecycles into one boolean and loses SUBMITTED / REJECTED states. (ref: DL-002) |
| Place the gate at the T-10 settlement handler (processSettlement) | By settlement time Xendit has already collected client funds; the platform can only delay payout, not prevent the invoice. The only point where rejecting is safe is before the Xendit invoice is created. (ref: DL-003) |
| Wire Xendit business-verification API submission now | Endpoint shape is M-confidence — unverified payload/document/webhook semantics risk shipping a broken slice that blocks every lab onboarding. Manual admin verification (T-13) ships zero-risk and the Xendit integration can be added later behind the same KycStatus enum. (ref: DL-004) |
| Upload through a Next.js Server Action FormData | Vercel runtime caps Server Action FormData at 4.5 MB; KYC docs target up to 20 MB. Direct presigned PUT bypasses the cap and removes the Next.js bottleneck from the data path. (ref: DL-005) |
| Let the client supply the R2 object key | Cross-lab path traversal — a malicious LAB_ADMIN could PUT into another lab's prefix. Server-generated keys derived from the session-resolved labId close the attack surface. (ref: DL-006) |
| Collapse per-document state into Lab.kycStatus (no DocumentStatus) | Aggregating per-document lifecycle into Lab.kycStatus requires composite logic on every read and breaks the principle that each entity owns its own status field. A separate DocumentStatus is the simpler invariant. (ref: DL-007) |
| Place r2.ts under src/lib/payments/ | R2 is object storage, not a payment provider; placing it under payments mis-categorizes the dependency surface and forces future storage clients into the wrong namespace. src/lib/storage/ is the correct home. (ref: DL-009) |
| Commit the integration test that hits a real R2 bucket | R2 credentials must not appear in CI; the SDK boundary (S3Client) is the correct mock seam. Unit-only tests cover every behavioural invariant of the slice. (ref: DL-013) |

### Constraints

- Attachment.orderId is NOT NULL — must not be modified for T-15
- Lab.isVerified is reserved for T-18 — must not be reused for KYC status
- Every external fetch must include AbortSignal.timeout(10_000) (Implementation Discipline)
- Every unhandled enum branch must throw, never default silently (Implementation Discipline)
- redirect() must be called after — never inside — any try/catch in Server Actions (Implementation Discipline)
- Enum dispatch tables must use as const satisfies Record<EnumType, …> (Implementation Discipline)
- Webhook/state-transition writes must use updateMany with a guard predicate (Implementation Discipline) — applied to LabDocument and Lab kyc transitions
- RSC pages must serialize Date via .toISOString() before passing to client components (Implementation Discipline)
- prisma/migrations/ is gitignored — apply locally with npx prisma migrate dev; PR commits only schema.prisma
- Cloudflare R2 bucket and API token must be provisioned before Session 2 — five env vars (CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ENDPOINT) added to .env.local and to Vercel before deploy
- VSA boundary — slice files do not import from other slices; storage client and Prisma client are the only cross-slice imports
- Allowed MIME types are application/pdf, image/jpeg, image/png; max file size 20 MB (20 * 1024 * 1024)

### Known Risks

- **R2 CORS policy blocks presigned PUT from the browser on first deployment**: Pre-session checklist documents the R2 CORS policy (allow PUT from production domain and http://localhost:3000); if encountered during Session 2 the slice CLAUDE.md notes the required allowed-origins entry.
- **Orphan LabDocument rows AND orphan R2 objects accumulate when the client abandons the upload after requestUploadUrl but before PUT or confirmUpload**: Documented in src/features/labs/kyc-upload/CLAUDE.md as an accepted tradeoff for atomicity per DL-018. A future GC ticket sweeps both orphan classes in one pass: for each LabDocument where status === PENDING AND createdAt < now - 24h, issue (1) a Prisma delete AND (2) an R2 DeleteObject by r2Key. R2 free tier absorbs the storage cost; no engineering risk for MVP.
- **Manual admin verification path (T-13) ships later than T-15; labs cannot reach APPROVED in the meantime**: Admin can flip Lab.kycStatus via a direct DB update or a one-off script until T-13 ships. The KycStatus enum is in place; only the UI is deferred. PR description and slice CLAUDE.md note this short-term workaround.
- **A future contributor adds a new KycStatus member (e.g. SUSPENDED) and forgets to update the badge dispatch — silent wrong UI**: The as const satisfies Record<KycStatus, …> shape makes a missing entry a compile-time error so npx tsc --noEmit fails until the new member is mapped.
- **Order.lab include not added consistently to both initiateCheckout and initiateVaCheckout — gate silently bypassed on the FVA path**: kyc-gate.test.ts asserts the gate on both actions with all four kycStatus values; missing include surfaces as a TypeScript error (lab is not on the Order include in the FVA path otherwise).

## Invisible Knowledge

### System

T-15 introduces lab-level KYC (payment-gateway verification) — distinct from the T-18 ISO 17025 accreditation track that owns Lab.isVerified. The KycStatus enum has four states: PENDING (default for any new Lab), SUBMITTED (at least one LabDocument has been uploaded), APPROVED (manual admin verification, written by T-13), REJECTED (manual admin verification). LabDocument is a lab-level document store keyed on labId; rows are created with status PENDING by the upload Server Action (after server-side MIME/size validation), then advance to UPLOADED in a Prisma $transaction at confirmUpload — the same transaction also advances Lab.kycStatus from PENDING to SUBMITTED when this is the lab's first upload. Documents store the R2 key (labs/{labId}/{cuid}.{ext}) under @unique; presigned PUT URLs are signed server-side with a 300 s TTL and bind Content-Type so the actual upload header must match. The checkout KYC gate blocks both invoice (initiateCheckout) and FVA (initiateVaCheckout) paths on Lab.kycStatus === APPROVED — the gate runs after the order-validity guards but before the PENDING-Transaction idempotency lookup, so unverified-lab checkouts never reach Xendit and never create a Transaction row. The settlement handler at src/features/payments/payouts/handlers.ts is intentionally NOT gated — by settlement time Xendit has already collected client funds, so any gate there can only delay payout (a worse outcome) instead of preventing the invoice. Xendit business-verification API submission is deferred: this slice does not call Xendit for KYC, and the manual admin verification UI (T-13) is the only writer of APPROVED. Storage credentials never reach the client — generatePresignedPutUrl and generatePresignedGetUrl live in src/lib/storage/r2.ts and are invoked only from Server Actions.

### Invariants

- Lab.kycStatus and Lab.isVerified are independent fields — T-15 owns kycStatus; T-18 owns isVerified
- Lab.kycStatus transitions: PENDING -> SUBMITTED (this slice, on first UPLOADED document) -> APPROVED | REJECTED (T-13 manual admin only)
- LabDocument.status transitions: PENDING (row created with presigned URL) -> UPLOADED (confirmUpload after client PUT to R2) -> VERIFIED | REJECTED (T-13 per-document review)
- r2Key is always labs/{labId}/{cuid}.{ext} — generated server-side; the client never supplies the key
- MIME and size are validated server-side before the presigned URL is signed; the signed URL also binds Content-Type so a header mismatch at PUT is rejected by R2
- Both checkout actions gate on order.lab.kycStatus === APPROVED before any Xendit call; the gate returns a user-visible ActionState error and never throws
- redirect() is the terminal statement in both checkout actions and never appears inside a try/catch
- All LabDocument and Lab kyc state writes use updateMany with a guard predicate; count === 0 is the idempotency / concurrent-write signal
- STATUS_BADGE in ui.tsx is `as const satisfies Record<KycStatus, …>` — a missing enum entry is a compile-time error
- src/lib/storage/r2.ts depends on @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner — the slice has no other new dependency

### Tradeoffs

- New LabDocument model vs nullable Attachment.orderId — chose a strictly additive model over a nullable FK to keep the existing Attachment surface unchanged; cost is one extra model in the schema, benefit is zero migration risk on existing rows.
- Manual admin verification vs Xendit API submission — chose to ship faster with manual verification; cost is the T-13 admin UI is a release blocker for any lab to reach APPROVED, benefit is zero external-API risk and a clean place to wire Xendit later behind the same KycStatus enum.
- Presigned PUT URL vs Next.js Server Action streaming — chose presigned PUT to bypass the 4.5 MB Vercel cap; cost is a two-step upload flow (request -> PUT -> confirm) with a possible orphan row if the client abandons mid-flow, benefit is reliable 20 MB uploads with no server bandwidth tax.
- Server-generated r2Key vs client-supplied key — chose server-generated to close the cross-lab path-traversal vector; cost is the client cannot resume a partial upload with a stable key (re-request the URL after failure), benefit is the upload surface is exploit-free.
- Unit tests only vs integration with a real R2 bucket — chose unit tests at the SDK boundary; cost is CORS / signature edge cases must be caught at deployment, benefit is no credentials in CI and tests stay fast.

## Milestones

### Milestone 1: R2 storage client

**Files**: package.json, src/lib/storage/r2.ts

**Requirements**:

- Add @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner to dependencies
- Export generatePresignedPutUrl(key, contentType, contentLength) -> Promise<string> with 300 s TTL and Content-Type binding
- Throw R2ConfigError when any of CLOUDFLARE_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_ENDPOINT env vars are absent
- Reject keys not starting with the labs/ prefix with R2ValidationError
- Allowlist MIME types: application/pdf | image/jpeg | image/png — reject all other values with R2ValidationError
- Max contentLength 20 * 1024 * 1024 bytes (20 MB) — reject larger with R2ValidationError
- generatePresignedGetUrl is intentionally NOT implemented in T-15 (deferred to T-13 admin review per DL-017)

**Acceptance Criteria**:

- npm install completes; npx tsc --noEmit passes
- generatePresignedPutUrl rejects unknown MIME with R2ValidationError
- generatePresignedPutUrl rejects oversize (>20 MB) with R2ValidationError
- generatePresignedPutUrl rejects key without labs/ prefix with R2ValidationError
- generatePresignedPutUrl throws R2ConfigError when any required env var is unset
- generatePresignedPutUrl returns a URL string containing the bucket host derived from R2_ENDPOINT when all inputs are valid
- src/lib/storage/r2.ts exports no generatePresignedGetUrl symbol

#### Code Intent

- **CI-M-001-001** `package.json::dependencies`: Add @aws-sdk/client-s3 ^3.700.0 and @aws-sdk/s3-request-presigner ^3.700.0 to dependencies. No other changes. (refs: DL-005, DL-009)
- **CI-M-001-002** `src/lib/storage/r2.ts::R2 client module`: Module-level: declare ALLOWED_MIME_TYPES = ['application/pdf','image/jpeg','image/png'] as const; MAX_BYTES = 20 * 1024 * 1024. Read env via getR2Config() that throws R2ConfigError when CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, or R2_ENDPOINT are absent (lazy — called inside each exported function, not at import time, to keep tests cheap). buildS3Client() returns S3Client({ region:'auto', endpoint: R2_ENDPOINT, credentials: { accessKeyId, secretAccessKey } }). validateMime(mime) and validateSize(size) throw R2ValidationError with a precise message. generatePresignedPutUrl(key, contentType, contentLength): assert key startsWith 'labs/' (R2ValidationError otherwise); validateMime(contentType); validateSize(contentLength); return getSignedUrl(client, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: contentLength }), { expiresIn: 300 }). Export R2ConfigError extends Error and R2ValidationError extends Error. NOTE: generatePresignedGetUrl is intentionally NOT exported in T-15 (per DL-017 — KYC docs are never re-served to clients in this slice; T-13 admin review will reintroduce it with a justified TTL). (refs: DL-005, DL-006, DL-008, DL-009, DL-017)

#### Code Changes

**CC-M-001-001** (package.json) - implements CI-M-001-001

**Code:**

```diff
--- a/package.json
+++ b/package.json
@@ -9,4 +9,6 @@
   "dependencies": {
     "@auth/prisma-adapter": "2.7.2",
     "@paralleldrive/cuid2": "^2.3.1",
+    "@aws-sdk/client-s3": "^3.700.0",
+    "@aws-sdk/s3-request-presigner": "^3.700.0",
     "@prisma/client": "^5.22.0",
```

**Documentation:**

```diff
--- a/package.json
+++ b/package.json
@@ -9,4 +9,6 @@
   "dependencies": {
     "@auth/prisma-adapter": "2.7.2",
     "@paralleldrive/cuid2": "^2.3.1",
     "@aws-sdk/client-s3": "^3.700.0",
     "@aws-sdk/s3-request-presigner": "^3.700.0",
     "@prisma/client": "^5.22.0",

```


**CC-M-001-002** (src/lib/storage/r2.ts) - implements CI-M-001-002

**Code:**

```diff
--- a/src/lib/storage/r2.ts
+++ b/src/lib/storage/r2.ts
@@ -0,0 +1,96 @@
+import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
+import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
+
+export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
+export const MAX_BYTES = 20 * 1024 * 1024
+
+export class R2ConfigError extends Error {
+  constructor(message: string) {
+    super(message)
+    this.name = 'R2ConfigError'
+  }
+}
+
+export class R2ValidationError extends Error {
+  constructor(message: string) {
+    super(message)
+    this.name = 'R2ValidationError'
+  }
+}
+
+type R2Config = {
+  accountId: string
+  accessKeyId: string
+  secretAccessKey: string
+  bucketName: string
+  endpoint: string
+}
+
+function getR2Config(): R2Config {
+  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
+  const accessKeyId = process.env.R2_ACCESS_KEY_ID
+  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
+  const bucketName = process.env.R2_BUCKET_NAME
+  const endpoint = process.env.R2_ENDPOINT
+
+  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !endpoint) {
+    throw new R2ConfigError(
+      'R2 config incomplete — CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ENDPOINT must all be set',
+    )
+  }
+
+  return { accountId, accessKeyId, secretAccessKey, bucketName, endpoint }
+}
+
+function buildS3Client(config: R2Config): S3Client {
+  return new S3Client({
+    region: 'auto',
+    endpoint: config.endpoint,
+    credentials: {
+      accessKeyId: config.accessKeyId,
+      secretAccessKey: config.secretAccessKey,
+    },
+  })
+}
+
+function validateMime(contentType: string): void {
+  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(contentType)) {
+    throw new R2ValidationError(
+      `Unsupported MIME type: ${contentType}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`,
+    )
+  }
+}
+
+function validateSize(contentLength: number): void {
+  if (contentLength > MAX_BYTES) {
+    throw new R2ValidationError(
+      `File size ${contentLength} exceeds maximum ${MAX_BYTES} bytes (20 MB)`,
+    )
+  }
+}
+
+export async function generatePresignedPutUrl(
+  key: string,
+  contentType: string,
+  contentLength: number,
+): Promise<string> {
+  if (!key.startsWith('labs/')) {
+    throw new R2ValidationError(`Key must start with 'labs/' prefix: ${key}`)
+  }
+  validateMime(contentType)
+  validateSize(contentLength)
+
+  const config = getR2Config()
+  const client = buildS3Client(config)
+
+  return getSignedUrl(
+    client,
+    new PutObjectCommand({
+      Bucket: config.bucketName,
+      Key: key,
+      ContentType: contentType,
+      ContentLength: contentLength,
+    }),
+    { expiresIn: 300 },
+  )
+}
```

**Documentation:**

```diff
--- a/src/lib/storage/r2.ts
+++ b/src/lib/storage/r2.ts
@@ -0,0 +1,96 @@
+/**
+ * Cloudflare R2 storage client — presigned PUT URL generation for KYC document uploads.
+ *
+ * Lives under src/lib/storage/ (not src/lib/payments/) because R2 is object storage,
+ * not a payment provider. (ref: DL-009)
+ *
+ * Only generatePresignedPutUrl is exported. generatePresignedGetUrl is not implemented
+ * in this slice — KYC docs are never re-served to clients here. (ref: DL-017)
+ *
+ * Required env vars: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
+ * R2_BUCKET_NAME, R2_ENDPOINT (https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com)
+ */
+import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
+import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
+
+/** application/pdf, image/jpeg, image/png — KYC document allowlist. */
+export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
+/** 20 MB ceiling for KYC document uploads (BIR 2303, DTI/SEC registration, etc.). */
+export const MAX_BYTES = 20 * 1024 * 1024
+
+/** Thrown when required R2 env vars are missing. */
+export class R2ConfigError extends Error {
+  constructor(message: string) {
+    super(message)
+    this.name = 'R2ConfigError'
+  }
+}
+
+/** Thrown when MIME type, file size, or key prefix validation fails. (ref: DL-008) */
+export class R2ValidationError extends Error {
+  constructor(message: string) {
+    super(message)
+    this.name = 'R2ValidationError'
+  }
+}
+
+type R2Config = {
+  accountId: string
+  accessKeyId: string
+  secretAccessKey: string
+  bucketName: string
+  endpoint: string
+}
+
+/** Reads and validates R2 env vars; throws R2ConfigError if any are absent. */
+function getR2Config(): R2Config {
+  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
+  const accessKeyId = process.env.R2_ACCESS_KEY_ID
+  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
+  const bucketName = process.env.R2_BUCKET_NAME
+  const endpoint = process.env.R2_ENDPOINT
+
+  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !endpoint) {
+    throw new R2ConfigError(
+      'R2 config incomplete — CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ENDPOINT must all be set',
+    )
+  }
+
+  return { accountId, accessKeyId, secretAccessKey, bucketName, endpoint }
+}
+
+function buildS3Client(config: R2Config): S3Client {
+  return new S3Client({
+    region: 'auto', // R2 uses 'auto'; an explicit region would be rejected
+    endpoint: config.endpoint,
+    credentials: {
+      accessKeyId: config.accessKeyId,
+      secretAccessKey: config.secretAccessKey,
+    },
+  })
+}
+
+function validateMime(contentType: string): void {
+  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(contentType)) {
+    throw new R2ValidationError(
+      `Unsupported MIME type: ${contentType}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`,
+    )
+  }
+}
+
+function validateSize(contentLength: number): void {
+  if (contentLength > MAX_BYTES) {
+    throw new R2ValidationError(
+      `File size ${contentLength} exceeds maximum ${MAX_BYTES} bytes (20 MB)`,
+    )
+  }
+}
+
+/**
+ * Returns a presigned PUT URL for uploading a single KYC document directly to R2.
+ *
+ * TTL is 300 s — bounds the exploit window for a leaked URL while accommodating
+ * slow mobile uploads. (ref: DL-005)
+ *
+ * The Content-Type is bound into the signed URL; R2 rejects PUTs whose actual
+ * Content-Type header does not match the signed value. (ref: DL-008)
+ *
+ * @param key    Must start with 'labs/' — enforced to prevent cross-prefix writes.
+ *               Key shape: labs/{labId}/{cuid}.{ext}, always generated server-side. (ref: DL-006)
+ * @param contentType  Must be in ALLOWED_MIME_TYPES.
+ * @param contentLength  Must be <= MAX_BYTES.
+ * @throws R2ValidationError  key prefix, MIME, or size check failed.
+ * @throws R2ConfigError      env vars missing.
+ */
+export async function generatePresignedPutUrl(
+  key: string,
+  contentType: string,
+  contentLength: number,
+): Promise<string> {
+  if (!key.startsWith('labs/')) {
+    throw new R2ValidationError(`Key must start with 'labs/' prefix: ${key}`)
+  }
+  validateMime(contentType)
+  validateSize(contentLength)
+
+  const config = getR2Config()
+  const client = buildS3Client(config)
+
+  return getSignedUrl(
+    client,
+    new PutObjectCommand({
+      Bucket: config.bucketName,
+      Key: key,
+      ContentType: contentType,
+      ContentLength: contentLength,
+    }),
+    { expiresIn: 300 },
+  )
+}

```


**CC-M-001-003** (src/lib/storage/README.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/lib/storage/README.md
@@ -0,0 +1,19 @@
+# src/lib/storage
+
+Object storage clients. Separate from `src/lib/payments/` — storage is not a payment provider.
+
+## Contents
+
+| File | Purpose |
+|------|---------|
+| `r2.ts` | Cloudflare R2 presigned PUT URL generation for KYC document uploads |
+| `__tests__/r2.test.ts` | Unit tests — mocks S3Client at SDK boundary |
+
+## r2.ts
+
+Exports `generatePresignedPutUrl(key, contentType, contentLength)`. Key must start with `labs/`.
+MIME and size validation happen before signing; the signed URL also binds `Content-Type` so R2
+rejects mismatched PUTs at upload time.
+
+`generatePresignedGetUrl` is not implemented here — KYC docs are never re-served to
+clients in this slice. Add it in the slice that requires document read access.

```


### Milestone 2: KycStatus + DocumentStatus + LabDocument schema

**Files**: prisma/schema.prisma

**Requirements**:

- Add enum KycStatus { PENDING SUBMITTED APPROVED REJECTED } in the enum block
- Add enum DocumentStatus { PENDING UPLOADED VERIFIED REJECTED } in the enum block — distinct from KycStatus
- Add Lab.kycStatus KycStatus @default(PENDING) — Lab.isVerified remains unchanged (reserved for T-18)
- Promote Lab.ownerId to @unique and remove the existing @@index([ownerId]) — schema-level invariant for one-lab-per-owner (DL-015)
- Add model LabDocument { id String @id @default(cuid()); labId String; uploadedById String; documentType String; r2Key String @unique; fileName String; fileSize Int; mimeType String; status DocumentStatus @default(PENDING); createdAt DateTime @default(now()); updatedAt DateTime @updatedAt; lab Lab @relation(fields:[labId], references:[id]); uploadedBy User @relation(fields:[uploadedById], references:[id]); @@index([labId, status]); @@map("lab_documents") }
- Add Lab.documents LabDocument[] back-relation
- Add User.labDocuments LabDocument[] back-relation
- Migration is applied locally via npx prisma migrate dev --name add-lab-kyc-status — prisma/migrations/ stays gitignored (DL-014)

**Acceptance Criteria**:

- npx prisma generate succeeds without warnings
- npx tsc --noEmit passes against the regenerated Prisma client
- Lab.isVerified field is unchanged (same default, same type)
- Lab.ownerId is now @unique and the @@index([ownerId]) line is removed
- KycStatus enum exports PENDING, SUBMITTED, APPROVED, REJECTED — does NOT include UPLOADED or VERIFIED
- DocumentStatus enum exports PENDING, UPLOADED, VERIFIED, REJECTED — does NOT include SUBMITTED
- src/features/labs/onboarding/action.ts compiles with findUnique (migrated from findFirst per DL-015 — Lab.ownerId is now @unique)

#### Code Intent

- **CI-M-002-001** `prisma/schema.prisma::KycStatus enum`: Insert enum KycStatus { PENDING SUBMITTED APPROVED REJECTED } in the enum block (alongside PayoutStatus and TransactionStatus). (refs: DL-002)
- **CI-M-002-002** `prisma/schema.prisma::DocumentStatus enum`: Insert enum DocumentStatus { PENDING UPLOADED VERIFIED REJECTED } in the enum block — distinct from KycStatus. (refs: DL-007)
- **CI-M-002-003** `prisma/schema.prisma::Lab.kycStatus field`: Add `kycStatus KycStatus @default(PENDING)` to the Lab model, positioned after isVerified. Lab.isVerified is unchanged. Add @unique to Lab.ownerId (promote the runtime guard already in src/features/labs/onboarding/action.ts to a schema-level invariant per DL-015) — replace the existing @@index([ownerId]) with @unique on the field. Add `documents LabDocument[]` to the Lab model relations block (alongside services, orders, attachments, wallet, payouts). (refs: DL-002, DL-015)
- **CI-M-002-004** `prisma/schema.prisma::LabDocument model`: Append model LabDocument { id String @id @default(cuid()); labId String; uploadedById String; documentType String; r2Key String @unique; fileName String; fileSize Int; mimeType String; status DocumentStatus @default(PENDING); createdAt DateTime @default(now()); updatedAt DateTime @updatedAt; lab Lab @relation(fields:[labId], references:[id]); uploadedBy User @relation(fields:[uploadedById], references:[id]); @@index([labId, status]); @@map("lab_documents") } after Attachment. Add `labDocuments LabDocument[]` to the User model relations block. (refs: DL-001, DL-006, DL-007)

#### Code Changes

**CC-M-002-001** (prisma/schema.prisma) - implements CI-M-002-001

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -54,6 +54,13 @@ enum TransactionStatus {
 enum PayoutStatus {
   QUEUED
   PROCESSING
   COMPLETED
   FAILED
 }
+
+enum KycStatus {
+  PENDING
+  SUBMITTED
+  APPROVED
+  REJECTED
+}

```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -54,6 +54,19 @@ enum TransactionStatus {
 enum PayoutStatus {
   QUEUED
   PROCESSING
   COMPLETED
   FAILED
 }
+
+// Lab-wide KYC verification status. Distinct from Lab.isVerified, which is reserved
+// for T-18 ISO 17025 accreditation — a separate regulatory lifecycle. (ref: DL-002)
+// Transitions: PENDING -> SUBMITTED (first confirmUpload); SUBMITTED -> APPROVED|REJECTED (T-13 admin).
+// This slice never writes APPROVED or REJECTED. (ref: DL-004)
+enum KycStatus {
+  PENDING    // Default. Lab has not submitted any documents.
+  SUBMITTED  // At least one LabDocument reached UPLOADED; awaiting admin review.
+  APPROVED   // Admin-verified. Required before checkout proceeds. (ref: DL-003)
+  REJECTED   // Admin rejected documents. Lab must re-upload.
+}

```


**CC-M-002-002** (prisma/schema.prisma) - implements CI-M-002-002

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -60,5 +60,12 @@ enum KycStatus {
   APPROVED
   REJECTED
 }
+
+enum DocumentStatus {
+  PENDING
+  UPLOADED
+  VERIFIED
+  REJECTED
+}
 
 // 6 values: CHEMICAL_TESTING, BIOLOGICAL_TESTING, PHYSICAL_TESTING,

```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -60,5 +60,18 @@ enum KycStatus {
   APPROVED
   REJECTED
 }
+
+// Per-document upload lifecycle. Distinct from KycStatus — Lab.kycStatus aggregates
+// lab-wide state; DocumentStatus tracks each LabDocument row individually. (ref: DL-007)
+// Transitions: PENDING (row created, presigned URL issued) -> UPLOADED (confirmUpload fired)
+//              -> VERIFIED|REJECTED (T-13 admin review).
+enum DocumentStatus {
+  PENDING   // Row created + presigned URL issued; client has not confirmed upload yet.
+  UPLOADED  // Client PUT succeeded and confirmUpload completed.
+  VERIFIED  // Admin confirmed the document is acceptable (set by T-13).
+  REJECTED  // Admin rejected the document (set by T-13).
+}
 
 // 6 values: CHEMICAL_TESTING, BIOLOGICAL_TESTING, PHYSICAL_TESTING,

```


**CC-M-002-003** (prisma/schema.prisma) - implements CI-M-002-003

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -128,21 +128,22 @@ model Account {
 model Lab {
   id             String   @id @default(cuid())
-  ownerId        String
+  ownerId        String   @unique
   name           String
   description    String?
   location       Json?
   certifications String[]
   isVerified     Boolean  @default(false)
+  kycStatus      KycStatus @default(PENDING)
   createdAt      DateTime @default(now())
   updatedAt      DateTime @updatedAt
 
   owner       User         @relation(fields: [ownerId], references: [id])
   services    LabService[]
   orders      Order[]
   attachments Attachment[]
   wallet      LabWallet?
   payouts     Payout[]
+  documents   LabDocument[]
 
-  @@index([ownerId])
   @@map("labs")
 }

```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -128,21 +128,24 @@ model Account {
 model Lab {
   id             String   @id @default(cuid())
-  ownerId        String
+  ownerId        String   @unique  // One lab per owner. @unique enables findUnique({ where: { ownerId } })
+                                   // everywhere and enforces the invariant at the schema level. (ref: DL-015)
   name           String
   description    String?
   location       Json?
   certifications String[]
-  isVerified     Boolean  @default(false)
+  isVerified     Boolean  @default(false)  // Reserved for T-18 ISO 17025 accreditation. Do NOT use for KYC.
+  kycStatus      KycStatus @default(PENDING)  // Payment gateway KYC lifecycle. (ref: DL-002)
   createdAt      DateTime @default(now())
   updatedAt      DateTime @updatedAt
 
   owner     User         @relation(fields: [ownerId], references: [id])
   services  LabService[]
   orders    Order[]
   attachments Attachment[]
   wallet    LabWallet?
   payouts   Payout[]
+  documents LabDocument[]  // KYC documents for this lab. (ref: DL-001)
 
   @@map("labs")
 }

```


**CC-M-002-004** (prisma/schema.prisma) - implements CI-M-002-004

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -91,6 +91,7 @@ model User {
   accounts    Account[]
   labs        Lab[]
   orders      Order[]
   attachments Attachment[]
+  labDocuments LabDocument[]
 
   @@map("users")
@@ -247,4 +247,24 @@ model Attachment {
   @@map("attachments")
 }
 
+model LabDocument {
+  id           String         @id @default(cuid())
+  labId        String
+  uploadedById String
+  documentType String
+  r2Key        String         @unique
+  fileName     String
+  fileSize     Int
+  mimeType     String
+  status       DocumentStatus @default(PENDING)
+  createdAt    DateTime       @default(now())
+  updatedAt    DateTime       @updatedAt
+
+  lab        Lab  @relation(fields: [labId], references: [id])
+  uploadedBy User @relation(fields: [uploadedById], references: [id])
+
+  @@index([labId, status])
+  @@map("lab_documents")
+}
+
 model Transaction {

```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -91,6 +91,7 @@ model User {
   accounts    Account[]
   labs        Lab[]
   orders      Order[]
   attachments Attachment[]
+  labDocuments LabDocument[]
 
   @@map("users")
@@ -247,4 +247,30 @@ model Attachment {
   @@map("attachments")
 }
 
+// Stores KYC document metadata for lab verification.
+// Uses a dedicated model rather than extending Attachment because Attachment.orderId
+// is NOT NULL and KYC docs have no order context — nullable FK would pollute every
+// existing Attachment query. (ref: DL-001)
+//
+// documentType is a String (not an enum) to allow catalog expansion without schema
+// migrations. Server-side allowlist in upload-action.ts enforces valid values. (ref: DL-016)
+//
+// r2Key shape: labs/{labId}/{cuid}.{ext} — always generated server-side. (ref: DL-006)
+// Orphan rows (PENDING + no corresponding R2 object) are tolerated cost; a future GC
+// ticket sweeps both DB row and R2 object atomically. (ref: DL-018)
+model LabDocument {
+  id           String         @id @default(cuid())
+  labId        String
+  uploadedById String
+  documentType String         // Allowlist: BIR_2303 | DTI_SEC | OTHER. Extend in upload-action.ts. (ref: DL-016)
+  r2Key        String         @unique  // R2 object key; @unique prevents duplicate row for the same object
+  fileName     String
+  fileSize     Int
+  mimeType     String
+  status       DocumentStatus @default(PENDING)
+  createdAt    DateTime       @default(now())
+  updatedAt    DateTime       @updatedAt
+
+  lab        Lab  @relation(fields: [labId], references: [id])
+  uploadedBy User @relation(fields: [uploadedById], references: [id])
+
+  @@index([labId, status])  // Covers queries for PENDING rows in GC sweep and per-lab document lists.
+  @@map("lab_documents")
+}

```


**CC-M-002-005** (src/features/labs/onboarding/action.ts) - implements CI-M-002-003

**Code:**

```diff
--- a/src/features/labs/onboarding/action.ts
+++ b/src/features/labs/onboarding/action.ts
@@ -37,6 +37,6 @@ export async function registerLab(
   }
 
-  const existing = await prisma.lab.findFirst({
+  const existing = await prisma.lab.findUnique({
     where: { ownerId: session.user.id },
   })
   if (existing) {
```

**Documentation:**

```diff
--- a/src/features/labs/onboarding/action.ts
+++ b/src/features/labs/onboarding/action.ts
@@ -37,6 +37,7 @@ export async function registerLab(
   }
 
-  const existing = await prisma.lab.findFirst({
+  // findUnique enforces the @unique constraint at the query level (ref: DL-015).
+  const existing = await prisma.lab.findUnique({
     where: { ownerId: session.user.id },
   })
   if (existing) {

```


**CC-M-002-006** (src/features/labs/service-management/page.tsx) - implements CI-M-002-003

**Code:**

```diff
--- a/src/features/labs/service-management/page.tsx
+++ b/src/features/labs/service-management/page.tsx
@@ -7,5 +7,5 @@ export default async function ServiceManagementPage() {
   const session = await auth()
   if (!session?.user.id || session.user.role !== 'LAB_ADMIN') redirect('/auth/signin')
 
-  const lab = await prisma.lab.findFirst({ where: { ownerId: session.user.id } })
+  const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id } })
   if (!lab) notFound()
```

**Documentation:**

```diff
--- a/src/features/labs/service-management/page.tsx
+++ b/src/features/labs/service-management/page.tsx
@@ -7,5 +7,6 @@ export default async function ServiceManagementPage() {
   const session = await auth()
   if (!session?.user.id || session.user.role !== 'LAB_ADMIN') redirect('/auth/signin')
 
-  const lab = await prisma.lab.findFirst({ where: { ownerId: session.user.id } })
+  // findUnique: Lab.ownerId is @unique (ref: DL-015).
+  const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id } })
   if (!lab) notFound()

```


### Milestone 3: KYC upload slice (Server Actions + UI)

**Files**: src/features/labs/kyc-upload/upload-action.ts, src/features/labs/kyc-upload/confirm-action.ts, src/features/labs/kyc-upload/page.tsx, src/features/labs/kyc-upload/ui.tsx, src/features/labs/kyc-upload/CLAUDE.md, src/app/dashboard/lab/kyc/page.tsx

**Requirements**:

- upload-action.ts exports requestUploadUrl(prev
- formData) returning ActionState | { presignedUrl
- r2Key
- labDocumentId }; auth guard requires session.user.role === 'LAB_ADMIN'; verify Lab.ownerId === session.user.id via prisma.lab.findUnique; validate documentType against ['BIR_2303'
- 'DTI_SEC'
- 'OTHER'] allowlist; validate fileName + mimeType + fileSize against MIME allowlist and 20 MB ceiling; generate r2Key = labs/{lab.id}/{createId()}.{ext-derived-from-mimeType}; prisma.labDocument.create with status PENDING + r2Key + metadata BEFORE calling generatePresignedPutUrl; if presigning throws
- surface ActionState error message and let the orphan LabDocument row remain (cleaned up by a future GC ticket
- documented in slice CLAUDE.md). confirm-action.ts exports confirmUpload(prev
- formData) taking labDocumentId; auth guard re-validates LAB_ADMIN ownership; wrap two writes in prisma.$transaction: (1) tx.labDocument.updateMany({ where: { id
- labId
- status: 'PENDING' }
- data: { status: 'UPLOADED' } }) — if count === 0 early-return success (idempotent re-confirm); (2) tx.lab.updateMany({ where: { id: labId
- kycStatus: 'PENDING' }
- data: { kycStatus: 'SUBMITTED' } }) — count === 0 is acceptable (lab already SUBMITTED). page.tsx is the LAB_ADMIN RSC page; reads Lab.kycStatus + LabDocument[] for the owned lab; passes a serialized DTO (Decimal n/a; createdAt -> ISOString) to ui.tsx. ui.tsx is the client component: file picker
- MIME + size pre-check (mirror server allowlist for fast feedback)
- client PUT to presignedUrl with AbortSignal.timeout(60_000)
- then call confirmUpload; renders KycStatus badge via const STATUS_BADGE = { PENDING: ...
- SUBMITTED: ...
- APPROVED: ...
- REJECTED: ... } as const satisfies Record<KycStatus
- {label
- className}>. CLAUDE.md documents the slice invariants (key generation
- server-side validation
- two-step upload). src/app/dashboard/lab/kyc/page.tsx re-exports page.tsx as the routed RSC.

**Acceptance Criteria**:

- npx tsc --noEmit passes; redirect() never appears inside a try/catch in either action; presigned URL generation is called AFTER labDocument.create; updateMany guards used in confirmUpload; KycStatus badge uses as const satisfies Record<KycStatus
- …>; CLAUDE.md exists and lists the slice invariants

#### Code Intent

- **CI-M-003-001** `src/features/labs/kyc-upload/upload-action.ts::requestUploadUrl`: 'use server' Server Action signature: requestUploadUrl(_prev: ActionState, formData: FormData) => Promise<ActionState | { presignedUrl: string; r2Key: string; labDocumentId: string }>. Steps: (1) parse fileName, mimeType, fileSize (number), documentType from formData — return { message: 'Missing field.' } if any null. (2) auth() guard: session.user.role === 'LAB_ADMIN' or return { message: 'Unauthorized.' }. (3) const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id } }) — Lab.ownerId is @unique per DL-015; if !lab return { message: 'No lab found for user.' }. (4) const DOCUMENT_TYPE_ALLOWLIST = ['BIR_2303','DTI_SEC','OTHER'] as const (per DL-016); if (!DOCUMENT_TYPE_ALLOWLIST.includes(documentType as typeof DOCUMENT_TYPE_ALLOWLIST[number])) throw new Error(`Unknown documentType: ${documentType}`) — unhandled-branch throw per Implementation Discipline. (5) validateMime + validateSize via the same constants imported from r2.ts (do not re-declare). (6) const EXT_BY_MIME = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' } as const satisfies Record<typeof ALLOWED_MIME_TYPES[number], string>; const r2Key = `labs/${lab.id}/${createId()}.${EXT_BY_MIME[mimeType as keyof typeof EXT_BY_MIME]}`. (7) const doc = await prisma.labDocument.create({ data: { labId: lab.id, uploadedById: session.user.id, documentType, r2Key, fileName, fileSize, mimeType, status: 'PENDING' } }). (8) try { const presignedUrl = await generatePresignedPutUrl(r2Key, mimeType, fileSize); return { presignedUrl, r2Key, labDocumentId: doc.id } } catch (err) { if (err instanceof R2ValidationError || err instanceof R2ConfigError) return { message: 'Storage unavailable. Try again later.' }; throw err }. No redirect() in this action. Orphan LabDocument row on presigning failure is intentional and swept by the future GC ticket per DL-018. (refs: DL-005, DL-006, DL-008, DL-009, DL-015, DL-016, DL-018)
- **CI-M-003-002** `src/features/labs/kyc-upload/confirm-action.ts::confirmUpload`: 'use server' Server Action: confirmUpload(_prev: ActionState, formData: FormData) => Promise<ActionState>. Steps: (1) labDocumentId from formData — return error if null. (2) auth() LAB_ADMIN guard. (3) const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id } }) — Lab.ownerId is @unique per DL-015; error if missing. (4) await prisma.$transaction(async (tx) => { const docResult = await tx.labDocument.updateMany({ where: { id: labDocumentId, labId: lab.id, status: 'PENDING' }, data: { status: 'UPLOADED' } }); if (docResult.count === 0) return; const labResult = await tx.lab.updateMany({ where: { id: lab.id, kycStatus: 'PENDING' }, data: { kycStatus: 'SUBMITTED' } }); // labResult.count === 0 is acceptable: lab already SUBMITTED }). (5) revalidatePath('/dashboard/lab/kyc'). (6) return null (success ActionState). (refs: DL-007, DL-010, DL-015)
- **CI-M-003-003** `src/features/labs/kyc-upload/page.tsx::KycPage RSC`: Async RSC. auth() LAB_ADMIN guard; redirect to '/auth/signin' otherwise. const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id }, include: { documents: { orderBy: { createdAt: 'desc' } } } }) — Lab.ownerId is @unique per DL-015; if !lab notFound(). Build a serialized DTO: type KycPageDTO = { kycStatus: KycStatus; documents: { id: string; documentType: string; fileName: string; mimeType: string; status: DocumentStatus; createdAt: string }[] } — createdAt must be doc.createdAt.toISOString() (Implementation Discipline: RSC must not pass raw Date across the boundary). Render <KycUploadUi dto={dto} />. (refs: DL-002, DL-007, DL-015)
- **CI-M-003-004** `src/features/labs/kyc-upload/ui.tsx::KycUploadUi client component`: 'use client'. Receives KycPageDTO. Renders KycStatus badge using const STATUS_BADGE = { PENDING: {label:'Not started', className:'bg-gray-200'}, SUBMITTED: {label:'Pending review', className:'bg-yellow-200'}, APPROVED: {label:'Verified', className:'bg-green-200'}, REJECTED: {label:'Rejected', className:'bg-red-200'} } as const satisfies Record<KycStatus, { label: string; className: string }>. Below the badge, render the list of documents (file name, type, status). Below the list, render an <input type='file' accept='application/pdf,image/jpeg,image/png' /> + documentType <select>. On submit: (a) client-side MIME + size check mirroring r2.ts constants; (b) call requestUploadUrl via useActionState; (c) on success, fetch(presignedUrl, { method:'PUT', body: file, headers: { 'Content-Type': file.type }, signal: AbortSignal.timeout(60_000) }); (d) on PUT 200, call confirmUpload via a second useActionState. Status-bearing UI uses STATUS_BADGE dispatch — never a Record<string, …> fallback. (refs: DL-005, DL-008, DL-012)
- **CI-M-003-005** `src/features/labs/kyc-upload/CLAUDE.md::slice CLAUDE.md`: Document the slice invariants: (1) r2Key is generated server-side as labs/{labId}/{cuid}.{ext} — clients never supply the key. (2) MIME/size validated server-side at requestUploadUrl AND bound into the presigned PUT. (3) Two-step upload: request -> PUT to R2 -> confirm. (4) Lab.kycStatus transitions PENDING -> SUBMITTED only after at least one LabDocument reaches UPLOADED. (5) Manual admin verification (T-13) flips SUBMITTED -> APPROVED; this slice never writes APPROVED. (6) Orphan LabDocument rows AND orphan R2 objects (PUT succeeded, confirm never fired) are tolerated cost; a future GC ticket sweeps both: for each LabDocument with status === PENDING AND createdAt < now - 24h, the GC issues a DB delete AND an R2 DeleteObject by r2Key (single ticket covers both orphan classes per DL-018). (7) Slice depends on src/lib/storage/r2.ts and the LabDocument model; no domain-kernel imports. (8) documentType is a String column with a typed server-side allowlist [BIR_2303, DTI_SEC, OTHER] per DL-016 (extend the constant when adding document kinds — no schema migration required). (9) Lab.ownerId is @unique per DL-015 — all lab lookups use findUnique({where:{ownerId}}). (refs: DL-001, DL-004, DL-006, DL-007, DL-015, DL-016, DL-018)
- **CI-M-003-006** `src/app/dashboard/lab/kyc/page.tsx::route page`: Re-export the slice RSC: `export { default } from '@/features/labs/kyc-upload/page'`.

#### Code Changes

**CC-M-003-001** (src/features/labs/kyc-upload/upload-action.ts) - implements CI-M-003-001

**Code:**

```diff
--- a/src/features/labs/kyc-upload/upload-action.ts
+++ b/src/features/labs/kyc-upload/upload-action.ts
@@ -0,0 +1,72 @@
+'use server'
+
+import { createId } from '@paralleldrive/cuid2'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { generatePresignedPutUrl, ALLOWED_MIME_TYPES, MAX_BYTES, R2ValidationError, R2ConfigError } from '@/lib/storage/r2'
+
+type ActionState = { message?: string } | null
+
+const DOCUMENT_TYPE_ALLOWLIST = ['BIR_2303', 'DTI_SEC', 'OTHER'] as const
+type DocumentType = typeof DOCUMENT_TYPE_ALLOWLIST[number]
+
+const EXT_BY_MIME = {
+  'application/pdf': 'pdf',
+  'image/jpeg': 'jpg',
+  'image/png': 'png',
+} as const satisfies Record<typeof ALLOWED_MIME_TYPES[number], string>
+
+export async function requestUploadUrl(
+  _prev: ActionState,
+  formData: FormData,
+): Promise<ActionState | { presignedUrl: string; r2Key: string; labDocumentId: string }> {
+  const fileName = formData.get('fileName') as string | null
+  const mimeType = formData.get('mimeType') as string | null
+  const fileSizeRaw = formData.get('fileSize') as string | null
+  const documentType = formData.get('documentType') as string | null
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
+    return { message: `Unsupported file type. Allowed: PDF, JPEG, PNG.` }
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
--- a/src/features/labs/kyc-upload/upload-action.ts
+++ b/src/features/labs/kyc-upload/upload-action.ts
@@ -0,0 +1,72 @@
+'use server'
+
+import { createId } from '@paralleldrive/cuid2'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { generatePresignedPutUrl, ALLOWED_MIME_TYPES, MAX_BYTES, R2ValidationError, R2ConfigError } from '@/lib/storage/r2'
+
+type ActionState = { message?: string } | null
+
+// documentType is a free-form String column. Allowlist here is the single source of
+// truth; extend this constant to add new document kinds — no schema migration needed. (ref: DL-016)
+const DOCUMENT_TYPE_ALLOWLIST = ['BIR_2303', 'DTI_SEC', 'OTHER'] as const
+type DocumentType = typeof DOCUMENT_TYPE_ALLOWLIST[number]
+
+// as const satisfies Record<…>: compile error if ALLOWED_MIME_TYPES grows and EXT_BY_MIME is not updated.
+const EXT_BY_MIME = {
+  'application/pdf': 'pdf',
+  'image/jpeg': 'jpg',
+  'image/png': 'png',
+} as const satisfies Record<typeof ALLOWED_MIME_TYPES[number], string>
+
+/**
+ * Step 1 of the two-step KYC upload flow.
+ *
+ * Validates MIME type and file size server-side (belt-and-suspenders: the presigned URL
+ * also binds Content-Type so R2 rejects mismatched uploads at PUT time). (ref: DL-008)
+ *
+ * Creates the LabDocument row BEFORE generating the presigned URL. If presigning fails,
+ * the PENDING row becomes an orphan — swept by a future GC ticket. (ref: DL-018)
+ *
+ * r2Key is generated server-side as labs/{labId}/{cuid}.{ext}; clients never supply the
+ * key to prevent cross-lab path-traversal. (ref: DL-006)
+ *
+ * @returns presignedUrl + r2Key + labDocumentId on success; { message } on validation failure.
+ */
+export async function requestUploadUrl(
+  _prev: ActionState,
+  formData: FormData,
+): Promise<ActionState | { presignedUrl: string; r2Key: string; labDocumentId: string }> {
+  const fileName = formData.get('fileName') as string | null
+  const mimeType = formData.get('mimeType') as string | null
+  const fileSizeRaw = formData.get('fileSize') as string | null
+  const documentType = formData.get('documentType') as string | null
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
+  // findUnique: Lab.ownerId is @unique. (ref: DL-015)
+  const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id } })
+  if (!lab) return { message: 'No lab found for user.' }
+
+  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
+    return { message: `Unsupported file type. Allowed: PDF, JPEG, PNG.` }
+  }
+  if (fileSize > MAX_BYTES) {
+    return { message: 'File exceeds 20 MB limit.' }
+  }
+
+  // Unknown documentType is a contract violation (caller bypassed the form) — throw, don't default. (Implementation Discipline)
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
+    // R2ValidationError and R2ConfigError are surfaced as user-visible errors.
+    // The PENDING LabDocument row is NOT deleted — orphan tolerance per DL-018.
+    // Any other error is rethrown as an unhandled server fault.
+    if (err instanceof R2ValidationError || err instanceof R2ConfigError) {
+      return { message: 'Storage unavailable. Try again later.' }
+    }
+    throw err
+  }
+}

```


**CC-M-003-002** (src/features/labs/kyc-upload/confirm-action.ts) - implements CI-M-003-002

**Code:**

```diff
--- a/src/features/labs/kyc-upload/confirm-action.ts
+++ b/src/features/labs/kyc-upload/confirm-action.ts
@@ -0,0 +1,43 @@
+'use server'
+
+import { revalidatePath } from 'next/cache'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+
+type ActionState = { message?: string } | null
+
+export async function confirmUpload(
+  _prev: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const labDocumentId = formData.get('labDocumentId') as string | null
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
+  await prisma.$transaction(async (tx) => {
+    const docResult = await tx.labDocument.updateMany({
+      where: { id: labDocumentId, labId: lab.id, status: 'PENDING' },
+      data: { status: 'UPLOADED' },
+    })
+
+    if (docResult.count === 0) {
+      return
+    }
+
+    await tx.lab.updateMany({
+      where: { id: lab.id, kycStatus: 'PENDING' },
+      data: { kycStatus: 'SUBMITTED' },
+    })
+  })
+
+  revalidatePath('/dashboard/lab/kyc')
+
+  return null
+}
```

**Documentation:**

```diff
--- a/src/features/labs/kyc-upload/confirm-action.ts
+++ b/src/features/labs/kyc-upload/confirm-action.ts
@@ -0,0 +1,43 @@
+'use server'
+
+import { revalidatePath } from 'next/cache'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+
+type ActionState = { message?: string } | null
+
+/**
+ * Step 2 of the two-step KYC upload flow.
+ *
+ * Called by the client after a successful PUT to R2. Transitions the LabDocument from
+ * PENDING to UPLOADED, then conditionally advances Lab.kycStatus from PENDING to SUBMITTED
+ * inside a single $transaction — both writes succeed together or neither does. (ref: DL-010)
+ *
+ * Both updateMany calls use guard predicates (status === expected_value) following
+ * Implementation Discipline for state-transition writes. count === 0 means another
+ * delivery already advanced the state — early-return is the correct no-op. (ref: DL-010)
+ */
+export async function confirmUpload(
+  _prev: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const labDocumentId = formData.get('labDocumentId') as string | null
+  if (!labDocumentId) return { message: 'Missing labDocumentId.' }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  // findUnique: Lab.ownerId is @unique. (ref: DL-015)
+  const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id } })
+  if (!lab) return { message: 'No lab found for user.' }
+
+  await prisma.$transaction(async (tx) => {
+    // Guard: labId + status PENDING ensures this action only writes rows owned by the
+    // calling lab and only transitions PENDING -> UPLOADED once.
+    const docResult = await tx.labDocument.updateMany({
+      where: { id: labDocumentId, labId: lab.id, status: 'PENDING' },
+      data: { status: 'UPLOADED' },
+    })
+
+    if (docResult.count === 0) {
+      // Already UPLOADED (idempotent re-submit) or wrong labId — no-op.
+      return
+    }
+
+    // Only advance kycStatus to SUBMITTED when the lab is still PENDING.
+    // If lab is already SUBMITTED (prior upload confirmed), updateMany count will be 0 — also a no-op.
+    await tx.lab.updateMany({
+      where: { id: lab.id, kycStatus: 'PENDING' },
+      data: { kycStatus: 'SUBMITTED' },
+    })
+  })
+
+  revalidatePath('/dashboard/lab/kyc')
+
+  return null
+}

```


**CC-M-003-003** (src/features/labs/kyc-upload/page.tsx) - implements CI-M-003-003

**Code:**

```diff
--- a/src/features/labs/kyc-upload/page.tsx
+++ b/src/features/labs/kyc-upload/page.tsx
@@ -0,0 +1,45 @@
+import { notFound, redirect } from 'next/navigation'
+import { type KycStatus, type DocumentStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { KycUploadUi } from './ui'
+
+export type KycPageDTO = {
+  kycStatus: KycStatus
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
+export default async function KycPage() {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  const lab = await prisma.lab.findUnique({
+    where: { ownerId: session.user.id },
+    include: { documents: { orderBy: { createdAt: 'desc' } } },
+  })
+
+  if (!lab) notFound()
+
+  const dto: KycPageDTO = {
+    kycStatus: lab.kycStatus,
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
+  return <KycUploadUi dto={dto} />
+}

```

**Documentation:**

```diff
--- a/src/features/labs/kyc-upload/page.tsx
+++ b/src/features/labs/kyc-upload/page.tsx
@@ -0,0 +1,45 @@
+import { notFound, redirect } from 'next/navigation'
+import { type KycStatus, type DocumentStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { KycUploadUi } from './ui'
+
+/**
+ * RSC data shape passed to KycUploadUi.
+ *
+ * All Date fields are serialized to ISO strings before crossing the RSC boundary —
+ * Next.js cannot serialize raw Date objects. (Implementation Discipline)
+ */
+export type KycPageDTO = {
+  kycStatus: KycStatus
+  documents: {
+    id: string
+    documentType: string
+    fileName: string
+    mimeType: string
+    status: DocumentStatus
+    createdAt: string  // .toISOString() — raw Date must not cross RSC boundary
+  }[]
+}
+
+export default async function KycPage() {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  // findUnique: Lab.ownerId is @unique. (ref: DL-015)
+  const lab = await prisma.lab.findUnique({
+    where: { ownerId: session.user.id },
+    include: { documents: { orderBy: { createdAt: 'desc' } } },
+  })
+
+  if (!lab) notFound()
+
+  const dto: KycPageDTO = {
+    kycStatus: lab.kycStatus,
+    documents: lab.documents.map((doc) => ({
+      id: doc.id,
+      documentType: doc.documentType,
+      fileName: doc.fileName,
+      mimeType: doc.mimeType,
+      status: doc.status,
+      createdAt: doc.createdAt.toISOString(),  // serialize Date (Implementation Discipline)
+    })),
+  }
+
+  return <KycUploadUi dto={dto} />
+}

```


**CC-M-003-004** (src/features/labs/kyc-upload/ui.tsx) - implements CI-M-003-004

**Code:**

```diff
--- a/src/features/labs/kyc-upload/ui.tsx
+++ b/src/features/labs/kyc-upload/ui.tsx
@@ -0,0 +1,155 @@
+'use client'
+
+import { useActionState, useRef, useEffect } from 'react'
+import { type KycStatus, type DocumentStatus } from '@prisma/client'
+import { requestUploadUrl } from './upload-action'
+import { confirmUpload } from './confirm-action'
+import type { KycPageDTO } from './page'
+import { ALLOWED_MIME_TYPES, MAX_BYTES } from '@/lib/storage/r2'
+
+const STATUS_BADGE = {
+  PENDING:   { label: 'Not started',     className: 'bg-gray-200 text-gray-700' },
+  SUBMITTED: { label: 'Pending review',  className: 'bg-yellow-200 text-yellow-800' },
+  APPROVED:  { label: 'Verified',        className: 'bg-green-200 text-green-800' },
+  REJECTED:  { label: 'Rejected',        className: 'bg-red-200 text-red-700' },
+} as const satisfies Record<KycStatus, { label: string; className: string }>
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
+export function KycUploadUi({ dto }: { dto: KycPageDTO }) {
+  const badge = STATUS_BADGE[dto.kycStatus]
+  const fileRef = useRef<HTMLInputElement>(null)
+
+  const [uploadState, uploadAction, uploadPending] = useActionState<UploadState, FormData>(
+    requestUploadUrl,
+    null,
+  )
+  const [confirmState, confirmAction, confirmPending] = useActionState<ConfirmState, FormData>(
+    confirmUpload,
+    null,
+  )
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
+        if (!putRes.ok) return
+
+        const confirmFormData = new FormData()
+        confirmFormData.set('labDocumentId', result.labDocumentId)
+        void confirmAction(confirmFormData)
+      } catch {
+        // upload timed out or failed; orphan LabDocument row is swept by future GC
+      }
+    })()
+  }, [uploadState, confirmAction])
+
+  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
+    e.preventDefault()
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
+          <h1 className="text-2xl font-bold text-gray-900">KYC Verification</h1>
+          <div className="mt-2">
+            <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${badge.className}`}>
+              {badge.label}
+            </span>
+          </div>
+        </div>
+
+        {dto.documents.length > 0 && (
+          <div className="mb-6 bg-white rounded-lg shadow p-4">
+            <h2 className="text-sm font-medium text-gray-700 mb-3">Uploaded Documents</h2>
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
+        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4">
+          <div>
+            <label className="block text-sm font-medium text-gray-700 mb-1">Document type</label>
+            <select name="documentType" required className="w-full border rounded-md px-3 py-2 text-sm">
+              <option value="BIR_2303">BIR Form 2303 (Certificate of Registration)</option>
+              <option value="DTI_SEC">DTI / SEC Registration</option>
+              <option value="OTHER">Other supporting document</option>
+            </select>
+          </div>
+          <div>
+            <label className="block text-sm font-medium text-gray-700 mb-1">File (PDF, JPEG, PNG — max 20 MB)</label>
+            <input
+              ref={fileRef}
+              type="file"
+              accept="application/pdf,image/jpeg,image/png"
+              required
+              className="block w-full text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
+            />
+          </div>
+          {uploadState && 'message' in uploadState && uploadState.message && (
+            <p className="text-sm text-red-600">{uploadState.message}</p>
+          )}
+          {confirmState && 'message' in confirmState && confirmState.message && (
+            <p className="text-sm text-red-600">{confirmState.message}</p>
+          )}
+          <button
+            type="submit"
+            disabled={uploadPending || confirmPending}
+            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
+          >
+            {uploadPending || confirmPending ? 'Uploading…' : 'Upload Document'}
+          </button>
+        </form>
+      </div>
+    </div>
+  )
+}

```

**Documentation:**

```diff
--- a/src/features/labs/kyc-upload/ui.tsx
+++ b/src/features/labs/kyc-upload/ui.tsx
@@ -0,0 +1,155 @@
+'use client'
+
+import { useActionState, useRef, useEffect } from 'react'
+import { type KycStatus, type DocumentStatus } from '@prisma/client'
+import { requestUploadUrl } from './upload-action'
+import { confirmUpload } from './confirm-action'
+import type { KycPageDTO } from './page'
+import { ALLOWED_MIME_TYPES, MAX_BYTES } from '@/lib/storage/r2'
+
+// as const satisfies Record<KycStatus, …>: compile error if KycStatus gains a new
+// member without a corresponding badge entry. (ref: DL-012, Implementation Discipline)
+const STATUS_BADGE = {
+  PENDING:   { label: 'Not started',     className: 'bg-gray-200 text-gray-700' },
+  SUBMITTED: { label: 'Pending review',  className: 'bg-yellow-200 text-yellow-800' },
+  APPROVED:  { label: 'Verified',        className: 'bg-green-200 text-green-800' },
+  REJECTED:  { label: 'Rejected',        className: 'bg-red-200 text-red-700' },
+} as const satisfies Record<KycStatus, { label: string; className: string }>
+
+// Same pattern for DocumentStatus — compile-time exhaustiveness check. (ref: DL-012)
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
+/** KYC upload UI: renders lab kycStatus badge, uploaded document list, and upload form. */
+export function KycUploadUi({ dto }: { dto: KycPageDTO }) {
+  const badge = STATUS_BADGE[dto.kycStatus]
+  const fileRef = useRef<HTMLInputElement>(null)
+
+  const [uploadState, uploadAction, uploadPending] = useActionState<UploadState, FormData>(
+    requestUploadUrl,
+    null,
+  )
+  const [confirmState, confirmAction, confirmPending] = useActionState<ConfirmState, FormData>(
+    confirmUpload,
+    null,
+  )
+
+  // Two-step upload flow executed in this effect:
+  //   1. uploadAction returned a presignedUrl (uploadState has presignedUrl key).
+  //   2. PUT the file directly to R2 using the presigned URL. Timeout: 60 s.
+  //      AbortSignal.timeout per Implementation Discipline — prevents indefinite hang on slow R2.
+  //   3. On PUT success, call confirmAction to transition LabDocument PENDING -> UPLOADED.
+  //   4. On PUT failure, the PENDING LabDocument row is an orphan — swept by future GC. (ref: DL-018)
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
+          signal: AbortSignal.timeout(60_000),  // abort after 60 s (Implementation Discipline)
+        })
+        if (!putRes.ok) return
+
+        const confirmFormData = new FormData()
+        confirmFormData.set('labDocumentId', result.labDocumentId)
+        void confirmAction(confirmFormData)
+      } catch {
+        // upload timed out or failed; orphan LabDocument row is swept by future GC
+      }
+    })()
+  }, [uploadState, confirmAction])
+
+  // Client-side guard mirrors server-side validation in requestUploadUrl.
+  // Prevents form submission for obviously invalid files before a round-trip to the server.
+  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
+    e.preventDefault()
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
+          <h1 className="text-2xl font-bold text-gray-900">KYC Verification</h1>
+          <div className="mt-2">
+            <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${badge.className}`}>
+              {badge.label}
+            </span>
+          </div>
+        </div>
+
+        {dto.documents.length > 0 && (
+          <div className="mb-6 bg-white rounded-lg shadow p-4">
+            <h2 className="text-sm font-medium text-gray-700 mb-3">Uploaded Documents</h2>
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
+        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4">
+          <div>
+            <label className="block text-sm font-medium text-gray-700 mb-1">Document type</label>
+            <select name="documentType" required className="w-full border rounded-md px-3 py-2 text-sm">
+              <option value="BIR_2303">BIR Form 2303 (Certificate of Registration)</option>
+              <option value="DTI_SEC">DTI / SEC Registration</option>
+              <option value="OTHER">Other supporting document</option>
+            </select>
+          </div>
+          <div>
+            <label className="block text-sm font-medium text-gray-700 mb-1">File (PDF, JPEG, PNG — max 20 MB)</label>
+            <input
+              ref={fileRef}
+              type="file"
+              accept="application/pdf,image/jpeg,image/png"
+              required
+              className="block w-full text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
+            />
+          </div>
+          {uploadState && 'message' in uploadState && uploadState.message && (
+            <p className="text-sm text-red-600">{uploadState.message}</p>
+          )}
+          {confirmState && 'message' in confirmState && confirmState.message && (
+            <p className="text-sm text-red-600">{confirmState.message}</p>
+          )}
+          <button
+            type="submit"
+            disabled={uploadPending || confirmPending}
+            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
+          >
+            {uploadPending || confirmPending ? 'Uploading…' : 'Upload Document'}
+          </button>
+        </form>
+      </div>
+    </div>
+  )
+}

```


**CC-M-003-005** (src/features/labs/kyc-upload/CLAUDE.md) - implements CI-M-003-005

**Code:**

```diff
--- a/src/features/labs/kyc-upload/CLAUDE.md
+++ b/src/features/labs/kyc-upload/CLAUDE.md
@@ -0,0 +1,37 @@
+# kyc-upload slice
+
+KYC document upload for labs — presigned PUT URL to Cloudflare R2, tracks lab verification status.
+
+## Invariants
+
+1. `r2Key` is generated server-side as `labs/{labId}/{cuid}.{ext}` — clients never supply the key (cross-lab path-traversal prevention).
+2. MIME type and file size are validated server-side at `requestUploadUrl` AND the MIME type is bound into the presigned PUT URL (Content-Type header must match at upload time).
+3. Two-step upload flow: `requestUploadUrl` → client PUT to R2 → `confirmUpload`.
+4. `Lab.kycStatus` transitions `PENDING → SUBMITTED` only after at least one `LabDocument` reaches `UPLOADED`.
+5. Manual admin verification (T-13) is the only writer of `APPROVED` or `REJECTED` on `Lab.kycStatus`. This slice never writes `APPROVED`.
+6. Orphan `LabDocument` rows (row created, but client never PUT or never called `confirmUpload`) and orphan R2 objects (PUT succeeded, confirm never fired) are tolerated cost. Orphan rows are tolerated; a separate cleanup ticket tracks GC without specifying the algorithm here.
+7. Slice depends on `src/lib/storage/r2.ts` and the `LabDocument` Prisma model. No domain-kernel imports.
+8. `documentType` is a `String` column with a typed server-side allowlist `[BIR_2303, DTI_SEC, OTHER]`. To add a new document kind, extend the `DOCUMENT_TYPE_ALLOWLIST` constant in `upload-action.ts` — no schema migration required.
+9. `Lab.ownerId` is `@unique` — all lab lookups use `findUnique({ where: { ownerId } })`.
+
+## R2 provisioning (pre-session checklist)
+
+Before Session 2 (code deployment), the following must be provisioned by the operator:
+
+- Cloudflare R2 bucket in an APAC region
+- API token with `Object Read & Write` on the bucket
+- CORS policy on the bucket allowing `PUT` from the production domain and `http://localhost:3000`
+
+Required env vars (`.env.local` and Vercel):
+
+```
+CLOUDFLARE_ACCOUNT_ID=
+R2_ACCESS_KEY_ID=
+R2_SECRET_ACCESS_KEY=
+R2_BUCKET_NAME=
+R2_ENDPOINT=https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com
+```
+
+## Admin verification gap
+
+`Lab.kycStatus` can only reach `APPROVED` via the admin review UI (not yet built) or a direct DB update. Labs default to `PENDING` after registration; they reach `SUBMITTED` after uploading at least one document.
```

**Documentation:**

```diff
--- a/src/features/labs/kyc-upload/CLAUDE.md
+++ b/src/features/labs/kyc-upload/CLAUDE.md
@@ -0,0 +1,41 @@
+# kyc-upload slice
+
+KYC document upload for labs — presigned PUT URL to Cloudflare R2, tracks lab verification status.
+
+## Invariants
+
+1. `r2Key` is generated server-side as `labs/{labId}/{cuid}.{ext}` — clients never supply the key (cross-lab path-traversal prevention).
+2. MIME type and file size are validated server-side at `requestUploadUrl` AND the MIME type is bound into the presigned PUT URL (Content-Type header must match at upload time).
+3. Two-step upload flow: `requestUploadUrl` → client PUT to R2 → `confirmUpload`.
+4. `Lab.kycStatus` transitions `PENDING → SUBMITTED` only after at least one `LabDocument` reaches `UPLOADED`.
+5. The admin review UI is the only writer of `APPROVED` or `REJECTED` on `Lab.kycStatus`. This slice never writes `APPROVED`.
+6. Orphan `LabDocument` rows (row created, but client never PUT or never called `confirmUpload`) and orphan R2 objects (PUT succeeded, confirm never fired) are tolerated cost. Orphan rows are tolerated; a separate cleanup ticket tracks GC without specifying the algorithm here.
+7. Slice depends on `src/lib/storage/r2.ts` and the `LabDocument` Prisma model. No domain-kernel imports.
+8. `documentType` is a `String` column with a typed server-side allowlist `[BIR_2303, DTI_SEC, OTHER]`. To add a new document kind, extend the `DOCUMENT_TYPE_ALLOWLIST` constant in `upload-action.ts` — no schema migration required.
+9. `Lab.ownerId` is `@unique` — all lab lookups use `findUnique({ where: { ownerId } })`.
+
+## Schema migration convention
+
+`prisma/migrations/` is gitignored in this repository — migration files are applied locally with
+`npx prisma migrate dev --name add-lab-kyc-status` and are not committed. The PR commits only
+`prisma/schema.prisma`. (ref: DL-014)
+
+## R2 provisioning (pre-session checklist)
+
+Before Session 2 (code deployment), the following must be provisioned by the operator:
+
+- Cloudflare R2 bucket in an APAC region
+- API token with `Object Read & Write` on the bucket
+- CORS policy on the bucket allowing `PUT` from the production domain and `http://localhost:3000`
+
+Required env vars (`.env.local` and Vercel):
+
+```
+CLOUDFLARE_ACCOUNT_ID=
+R2_ACCESS_KEY_ID=
+R2_SECRET_ACCESS_KEY=
+R2_BUCKET_NAME=
+R2_ENDPOINT=https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com
+```
+
+## Admin verification gap
+
+`Lab.kycStatus` reaches `APPROVED` only when set by the admin review UI or a direct DB update. Labs default to `PENDING` after registration; they reach `SUBMITTED` after uploading at least one document.

```


**CC-M-003-006** (src/app/dashboard/lab/kyc/page.tsx) - implements CI-M-003-006

**Code:**

```diff
--- a/src/app/dashboard/lab/kyc/page.tsx
+++ b/src/app/dashboard/lab/kyc/page.tsx
@@ -0,0 +1,1 @@
+export { default } from '@/features/labs/kyc-upload/page'
```

**Documentation:**

```diff
--- a/src/app/dashboard/lab/kyc/page.tsx
+++ b/src/app/dashboard/lab/kyc/page.tsx
@@ -0,0 +1,1 @@
+// App Router entry point — delegates to the kyc-upload VSA slice.
+export { default } from '@/features/labs/kyc-upload/page'

```


### Milestone 4: Checkout KYC gate

**Files**: src/features/payments/checkout/action.ts

**Requirements**:

- Both initiateCheckout (invoice path) and initiateVaCheckout (FVA path) include a KYC gate immediately after the existing PAYMENT_PENDING / quotedPrice guards and before the PENDING-Transaction idempotency lookup; the Order lookup adds include: { lab: true } (initiateCheckout already includes clientProfile
- service; FVA path already includes service — both add lab); a missing order.lab after explicit include throws (per Implementation Discipline — referential-integrity violation); when order.lab.kycStatus !== 'APPROVED' the action returns ActionState { message: 'This lab is not yet verified. Payment cannot proceed.' } and never calls createXenditInvoice or createXenditVa; redirect() remains the terminal statement outside any try/catch in both actions

**Acceptance Criteria**:

- npx tsc --noEmit passes; both initiateCheckout and initiateVaCheckout return the KYC error string when the related Lab.kycStatus is PENDING
- SUBMITTED
- or REJECTED; both proceed to Xendit only when kycStatus === APPROVED; null order.lab after explicit include throws; redirect() position unchanged (terminal
- outside try/catch)

#### Code Intent

- **CI-M-004-001** `src/features/payments/checkout/action.ts::initiateCheckout`: After the existing order/clientProfile/quotedPrice guards (which already include service): change the order lookup `include` to `{ clientProfile: true, service: true, lab: true }`. After `if (!order.quotedPrice) ...` and before the PENDING-Transaction idempotency findFirst: insert `if (!order.lab) { throw new Error('Order.lab missing after explicit include — referential integrity violation') }` then `if (order.lab.kycStatus !== KycStatus.APPROVED) { return { message: 'This lab is not yet verified. Payment cannot proceed.' } }`. Import KycStatus from @prisma/client. Nothing else changes; redirect(checkoutUrl) remains the terminal statement outside the try/catch. (refs: DL-003, DL-011)
- **CI-M-004-002** `src/features/payments/checkout/action.ts::initiateVaCheckout`: Mirror of initiateCheckout: change the order lookup `include` from `{ service: true }` to `{ service: true, lab: true }`. After `if (order.quotedPrice.toNumber() <= PESONET_MIN_AMOUNT) ...` and before `isPesonetBankCode` and the PENDING-Transaction findFirst: insert the same null-lab throw and the same `if (order.lab.kycStatus !== KycStatus.APPROVED) return { message: 'This lab is not yet verified. Payment cannot proceed.' }`. Nothing else changes; redirect(redirectPath) remains the terminal statement outside the try/catch. (refs: DL-003, DL-011)

#### Code Changes

**CC-M-004-001** (src/features/payments/checkout/action.ts) - implements CI-M-004-001

**Code:**

```diff
--- a/src/features/payments/checkout/action.ts
+++ b/src/features/payments/checkout/action.ts
@@ -28,5 +28,5 @@ import { redirect } from 'next/navigation'
 import { redirect } from 'next/navigation'
-import { Prisma, OrderStatus, TransactionStatus } from '@prisma/client'
+import { Prisma, OrderStatus, TransactionStatus, KycStatus } from '@prisma/client'
 import { createId } from '@paralleldrive/cuid2'
 import { prisma } from '@/lib/prisma'
 import { auth } from '@/lib/auth'
@@ -52,6 +52,6 @@ export async function initiateCheckout(
   const order = await prisma.order.findUnique({
     where: { id: orderId },
-    include: { clientProfile: true, service: true },
+    include: { clientProfile: true, service: true, lab: true },
   })
 
   if (!order || order.clientId !== session.user.id) {
@@ -66,5 +66,12 @@ export async function initiateCheckout(
   if (!order.quotedPrice) {
     return { message: 'Order does not have a quoted price.' }
   }
 
+  if (!order.lab) {
+    throw new Error('Order.lab missing after explicit include — referential integrity violation')
+  }
+  if (order.lab.kycStatus !== KycStatus.APPROVED) {
+    return { message: 'This lab is not yet verified. Payment cannot proceed.' }
+  }
+
   // Idempotency guard: double-submit or browser back+resubmit must not create a
```

**Documentation:**

```diff
--- a/src/features/payments/checkout/action.ts
+++ b/src/features/payments/checkout/action.ts
@@ -28,5 +28,5 @@ import { redirect } from 'next/navigation'
 import { redirect } from 'next/navigation'
-import { Prisma, OrderStatus, TransactionStatus } from '@prisma/client'
+import { Prisma, OrderStatus, TransactionStatus, KycStatus } from '@prisma/client'
 import { createId } from '@paralleldrive/cuid2'
 import { prisma } from '@/lib/prisma'
 import { auth } from '@/lib/auth'
@@ -52,6 +52,6 @@ export async function initiateCheckout(
   const order = await prisma.order.findUnique({
     where: { id: orderId },
-    include: { clientProfile: true, service: true },
+    include: { clientProfile: true, service: true, lab: true },  // lab required for KYC gate below
   })
 
   if (!order || order.clientId !== session.user.id) {
@@ -66,5 +66,16 @@ export async function initiateCheckout(
   if (!order.quotedPrice) {
     return { message: 'Order does not have a quoted price.' }
   }
 
+  // Referential integrity guard: a null lab after explicit include is a data corruption
+  // event, not a missing-row case. throw, not notFound(). (Implementation Discipline)
+  if (!order.lab) {
+    throw new Error('Order.lab missing after explicit include — referential integrity violation')
+  }
+  // KYC gate: block both invoice and VA checkout paths until the lab is admin-verified.
+  // Gate is placed after order-validity guards (more specific errors first) but before the
+  // PENDING-Transaction idempotency lookup — an unverified lab must never reach Xendit even
+  // if a pre-existing PENDING Transaction exists. (ref: DL-011)
+  if (order.lab.kycStatus !== KycStatus.APPROVED) {
+    return { message: 'This lab is not yet verified. Payment cannot proceed.' }
+  }
+
   // Idempotency guard: double-submit or browser back+resubmit must not create a

```


**CC-M-004-002** (src/features/payments/checkout/action.ts) - implements CI-M-004-002

**Code:**

```diff
--- a/src/features/payments/checkout/action.ts
+++ b/src/features/payments/checkout/action.ts
@@ -137,6 +137,6 @@ export async function initiateVaCheckout(
   const order = await prisma.order.findUnique({
     where: { id: orderId },
-    include: { service: true },
+    include: { service: true, lab: true },
   })
 
   if (!order || order.clientId !== session.user.id) {
@@ -153,6 +153,13 @@ export async function initiateVaCheckout(
   if (order.quotedPrice.toNumber() <= PESONET_MIN_AMOUNT) {
     return { message: 'PESONet is only available for orders above ₱50,000.' }
   }
 
+  if (!order.lab) {
+    throw new Error('Order.lab missing after explicit include — referential integrity violation')
+  }
+  if (order.lab.kycStatus !== KycStatus.APPROVED) {
+    return { message: 'This lab is not yet verified. Payment cannot proceed.' }
+  }
+
   // Bank code validation: allowlist enforced server-side to prevent injection
   if (!isPesonetBankCode(bankCode)) {
```

**Documentation:**

```diff
--- a/src/features/payments/checkout/action.ts
+++ b/src/features/payments/checkout/action.ts
@@ -137,6 +137,6 @@ export async function initiateVaCheckout(
   const order = await prisma.order.findUnique({
     where: { id: orderId },
-    include: { service: true },
+    include: { service: true, lab: true },  // lab required for KYC gate below
   })
 
   if (!order || order.clientId !== session.user.id) {
@@ -153,6 +153,16 @@ export async function initiateVaCheckout(
   if (order.quotedPrice.toNumber() <= PESONET_MIN_AMOUNT) {
     return { message: 'PESONet is only available for orders above ₱50,000.' }
   }
 
+  // Same KYC gate as initiateCheckout: gate covers both invoice and FVA/PESONet paths. (ref: DL-003, DL-011)
+  if (!order.lab) {
+    throw new Error('Order.lab missing after explicit include — referential integrity violation')
+  }
+  if (order.lab.kycStatus !== KycStatus.APPROVED) {
+    return { message: 'This lab is not yet verified. Payment cannot proceed.' }
+  }
+
   // Bank code validation: allowlist enforced server-side to prevent injection
   if (!isPesonetBankCode(bankCode)) {

```


### Milestone 5: Unit tests

**Files**: src/lib/storage/__tests__/r2.test.ts, src/features/labs/kyc-upload/__tests__/upload-action.test.ts, src/features/labs/kyc-upload/__tests__/confirm-action.test.ts, src/features/payments/checkout/__tests__/kyc-gate.test.ts

**Requirements**:

- r2.test.ts mocks @aws-sdk/s3-request-presigner.getSignedUrl and asserts: (a) disallowed MIME throws R2ValidationError; (b) oversize contentLength throws R2ValidationError; (c) missing env var throws R2ConfigError; (d) valid inputs return a URL containing the labs/{labId}/ prefix. upload-action.test.ts mocks prisma + r2 client + auth and asserts: (a) non-LAB_ADMIN session returns ActionState error; (b) lab.ownerId mismatch returns ActionState error; (c) MIME/size violations return ActionState error before any DB write; (d) success path creates LabDocument BEFORE calling generatePresignedPutUrl and returns the URL + r2Key + labDocumentId. confirm-action.test.ts mocks prisma.$transaction and asserts: (a) labDocument.updateMany is called with the PENDING guard predicate; (b) when updateMany returns count 0 the action early-returns success without writing the lab; (c) success path writes lab.updateMany with kycStatus PENDING guard; (d) ownership mismatch returns error. kyc-gate.test.ts mocks prisma and Xendit clients and asserts for each of initiateCheckout and initiateVaCheckout: (a) returns KYC error for kycStatus PENDING; (b) returns KYC error for kycStatus SUBMITTED; (c) returns KYC error for kycStatus REJECTED; (d) proceeds to the Xendit mock when kycStatus APPROVED; (e) Xendit mock is never invoked in cases (a)-(c).

**Acceptance Criteria**:

- npm test -- --run completes with all four suites passing; each suite has at least the listed assertions; no test touches a real DB or a real network endpoint

#### Code Intent

- **CI-M-005-001** `src/lib/storage/__tests__/r2.test.ts::r2 unit suite`: Vitest suite. Mock @aws-sdk/s3-request-presigner.getSignedUrl to return a fixed URL. Set all five env vars via vi.stubEnv. Cases: (1) generatePresignedPutUrl('labs/L1/x.pdf','application/pdf', 1024) resolves to the mocked URL. (2) generatePresignedPutUrl('labs/L1/x.exe','application/x-msdownload', 1024) rejects with R2ValidationError. (3) generatePresignedPutUrl('labs/L1/x.pdf','application/pdf', 21*1024*1024) rejects with R2ValidationError. (4) vi.unstubAllEnvs() before a config-error case; generatePresignedPutUrl throws R2ConfigError. (5) key without 'labs/' prefix throws R2ValidationError. (6) module export surface: r2.ts exports generatePresignedPutUrl, R2ConfigError, R2ValidationError, ALLOWED_MIME_TYPES, MAX_BYTES — and does NOT export generatePresignedGetUrl (per DL-017). (refs: DL-005, DL-006, DL-008, DL-013, DL-017)
- **CI-M-005-002** `src/features/labs/kyc-upload/__tests__/upload-action.test.ts::requestUploadUrl unit suite`: Vitest. Mock @/lib/auth (auth()), @/lib/prisma (prisma.lab.findUnique, prisma.labDocument.create), @/lib/storage/r2 (generatePresignedPutUrl). Cases: (a) non-LAB_ADMIN session returns { message } and never calls prisma; (b) lab.ownerId mismatch (findUnique returns null) returns { message }; (c) disallowed mimeType returns { message } before any prisma call; (d) oversize fileSize returns { message } before any prisma call; (e) unknown documentType (not in [BIR_2303, DTI_SEC, OTHER]) throws Error (unhandled-branch); (f) happy path: labDocument.create is invoked BEFORE generatePresignedPutUrl (assert mock invocation order); returned object has presignedUrl, r2Key starting with `labs/<labId>/`, and labDocumentId === doc.id; (g) generatePresignedPutUrl throwing R2ValidationError returns { message } and DOES NOT delete the orphan LabDocument row (per DL-018 future GC sweeps it). (refs: DL-006, DL-008, DL-013, DL-015, DL-016, DL-018)
- **CI-M-005-003** `src/features/labs/kyc-upload/__tests__/confirm-action.test.ts::confirmUpload unit suite`: Vitest. Mock prisma.lab.findUnique (used by ownership lookup) and prisma.$transaction to call the callback with a fake tx containing labDocument.updateMany and lab.updateMany. Cases: (a) non-LAB_ADMIN returns { message }; (b) ownership mismatch returns { message }; (c) labDocument.updateMany is called with where { id, labId, status: 'PENDING' } — exact object equality; (d) when labDocument.updateMany returns { count: 0 } the callback returns before invoking lab.updateMany (assert mock not called); (e) when labDocument.updateMany returns { count: 1 } lab.updateMany is called with where { id: labId, kycStatus: 'PENDING' } and data { kycStatus: 'SUBMITTED' }; (f) lab.updateMany returning { count: 0 } is treated as success (lab already SUBMITTED). (refs: DL-010, DL-013, DL-015)
- **CI-M-005-004** `src/features/payments/checkout/__tests__/kyc-gate.test.ts::checkout KYC gate unit suite`: Vitest. Mock @/lib/auth, @/lib/prisma (prisma.order.findUnique), @/lib/payments/xendit (createXenditInvoice), @/lib/payments/xendit-va (createXenditVa). For each combination of (action ∈ {initiateCheckout, initiateVaCheckout}, kycStatus ∈ {PENDING, SUBMITTED, REJECTED, APPROVED}): build a fake order whose findUnique result includes a lab with the given kycStatus plus the other required relations. Assertions: (a)(b)(c) for kycStatus PENDING/SUBMITTED/REJECTED, both actions return { message: 'This lab is not yet verified. Payment cannot proceed.' }; (d) for kycStatus APPROVED, the corresponding Xendit mock is invoked; (e) for the three non-APPROVED cases, neither Xendit mock is invoked (vi.fn().mockClear and assert .toHaveBeenCalledTimes(0)). Add one case: order with lab: null after explicit include throws ('referential integrity violation') for each action. (refs: DL-003, DL-011, DL-013)

#### Code Changes

**CC-M-005-001** (src/lib/storage/__tests__/r2.test.ts) - implements CI-M-005-001

**Code:**

```diff
--- a/src/lib/storage/__tests__/r2.test.ts
+++ b/src/lib/storage/__tests__/r2.test.ts
@@ -0,0 +1,72 @@
+import { describe, it, expect, vi, beforeEach } from 'vitest'
+
+const mockGetSignedUrl = vi.fn().mockResolvedValue('https://mock-r2.example.com/mock-url')
+
+vi.mock('@aws-sdk/s3-request-presigner', () => ({
+  getSignedUrl: mockGetSignedUrl,
+}))
+
+vi.mock('@aws-sdk/client-s3', () => ({
+  S3Client: vi.fn().mockImplementation(() => ({})),
+  PutObjectCommand: vi.fn().mockImplementation((params) => params),
+}))
+
+describe('r2 storage client', () => {
+  beforeEach(() => {
+    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account-id')
+    vi.stubEnv('R2_ACCESS_KEY_ID', 'test-access-key')
+    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret-key')
+    vi.stubEnv('R2_BUCKET_NAME', 'test-bucket')
+    vi.stubEnv('R2_ENDPOINT', 'https://test-account-id.r2.cloudflarestorage.com')
+    mockGetSignedUrl.mockClear()
+  })
+
+  it('returns a URL for valid inputs', async () => {
+    const { generatePresignedPutUrl } = await import('@/lib/storage/r2')
+    const url = await generatePresignedPutUrl('labs/L1/x.pdf', 'application/pdf', 1024)
+    expect(url).toBe('https://mock-r2.example.com/mock-url')
+    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1)
+  })
+
+  it('throws R2ValidationError for disallowed MIME type', async () => {
+    const { generatePresignedPutUrl, R2ValidationError } = await import('@/lib/storage/r2')
+    await expect(
+      generatePresignedPutUrl('labs/L1/x.exe', 'application/x-msdownload', 1024),
+    ).rejects.toBeInstanceOf(R2ValidationError)
+    expect(mockGetSignedUrl).not.toHaveBeenCalled()
+  })
+
+  it('throws R2ValidationError for oversize file', async () => {
+    const { generatePresignedPutUrl, R2ValidationError } = await import('@/lib/storage/r2')
+    await expect(
+      generatePresignedPutUrl('labs/L1/x.pdf', 'application/pdf', 21 * 1024 * 1024),
+    ).rejects.toBeInstanceOf(R2ValidationError)
+  })
+
+  it('throws R2ValidationError for key without labs/ prefix', async () => {
+    const { generatePresignedPutUrl, R2ValidationError } = await import('@/lib/storage/r2')
+    await expect(
+      generatePresignedPutUrl('uploads/x.pdf', 'application/pdf', 1024),
+    ).rejects.toBeInstanceOf(R2ValidationError)
+  })
+
+  it('throws R2ConfigError when env vars are absent', async () => {
+    vi.unstubAllEnvs()
+    const { generatePresignedPutUrl, R2ConfigError } = await import('@/lib/storage/r2')
+    await expect(
+      generatePresignedPutUrl('labs/L1/x.pdf', 'application/pdf', 1024),
+    ).rejects.toBeInstanceOf(R2ConfigError)
+  })
+
+  it('module exports generatePresignedPutUrl but NOT generatePresignedGetUrl', async () => {
+    const r2Module = await import('@/lib/storage/r2')
+    expect(typeof r2Module.generatePresignedPutUrl).toBe('function')
+    expect((r2Module as Record<string, unknown>)['generatePresignedGetUrl']).toBeUndefined()
+  })
+
+  it('module exports ALLOWED_MIME_TYPES and MAX_BYTES', async () => {
+    const { ALLOWED_MIME_TYPES, MAX_BYTES } = await import('@/lib/storage/r2')
+    expect(ALLOWED_MIME_TYPES).toContain('application/pdf')
+    expect(MAX_BYTES).toBe(20 * 1024 * 1024)
+  })
+})
```

**Documentation:**

```diff
--- a/src/lib/storage/__tests__/r2.test.ts
+++ b/src/lib/storage/__tests__/r2.test.ts
@@ -0,0 +1,72 @@
+// Unit tests for src/lib/storage/r2.ts.
+// Mocks @aws-sdk/s3-request-presigner and @aws-sdk/client-s3 at the SDK boundary.
+// Covers: MIME allowlist, size ceiling, key prefix guard, env var validation, and
+// absence of generatePresignedGetUrl (ref: DL-013, DL-017).
 import { describe, it, expect, vi, beforeEach } from 'vitest'

```


**CC-M-005-002** (src/features/labs/kyc-upload/__tests__/upload-action.test.ts) - implements CI-M-005-002

**Code:**

```diff
--- a/src/features/labs/kyc-upload/__tests__/upload-action.test.ts
+++ b/src/features/labs/kyc-upload/__tests__/upload-action.test.ts
@@ -0,0 +1,108 @@
+import { describe, it, expect, vi, beforeEach } from 'vitest'
+
+const mockLabFindUnique = vi.fn()
+const mockLabDocumentCreate = vi.fn()
+const mockGeneratePresignedPutUrl = vi.fn()
+
+vi.mock('@/lib/auth', () => ({
+  auth: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    lab: { findUnique: mockLabFindUnique },
+    labDocument: { create: mockLabDocumentCreate },
+  },
+}))
+
+vi.mock('@/lib/storage/r2', async (importOriginal) => {
+  const original = await importOriginal<typeof import('@/lib/storage/r2')>()
+  return {
+    ...original,
+    generatePresignedPutUrl: mockGeneratePresignedPutUrl,
+  }
+})
+
+const { auth } = await import('@/lib/auth')
+const mockAuth = vi.mocked(auth)
+
+import { requestUploadUrl } from '../upload-action'
+
+const labAdminSession = { user: { id: 'user-1', role: 'LAB_ADMIN' } }
+const mockLab = { id: 'lab-1', ownerId: 'user-1' }
+const mockDoc = { id: 'doc-1' }
+
+function makeFormData(overrides: Record<string, string> = {}) {
+  const fd = new FormData()
+  fd.set('fileName', overrides.fileName ?? 'test.pdf')
+  fd.set('mimeType', overrides.mimeType ?? 'application/pdf')
+  fd.set('fileSize', overrides.fileSize ?? '1024')
+  fd.set('documentType', overrides.documentType ?? 'BIR_2303')
+  return fd
+}
+
+describe('requestUploadUrl', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mockAuth.mockResolvedValue(labAdminSession as ReturnType<typeof auth> extends Promise<infer T> ? T : never)
+    mockLabFindUnique.mockResolvedValue(mockLab)
+    mockLabDocumentCreate.mockResolvedValue(mockDoc)
+    mockGeneratePresignedPutUrl.mockResolvedValue('https://presigned.example.com/put-url')
+  })
+
+  it('returns error for non-LAB_ADMIN session', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'user-1', role: 'CLIENT' } } as ReturnType<typeof auth> extends Promise<infer T> ? T : never)
+    const result = await requestUploadUrl(null, makeFormData())
+    expect(result).toMatchObject({ message: expect.any(String) })
+    expect(mockLabFindUnique).not.toHaveBeenCalled()
+  })
+
+  it('returns error when lab not found for user', async () => {
+    mockLabFindUnique.mockResolvedValue(null)
+    const result = await requestUploadUrl(null, makeFormData())
+    expect(result).toMatchObject({ message: expect.any(String) })
+    expect(mockLabDocumentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns error for disallowed MIME type without DB write', async () => {
+    const result = await requestUploadUrl(null, makeFormData({ mimeType: 'text/plain' }))
+    expect(result).toMatchObject({ message: expect.any(String) })
+    expect(mockLabDocumentCreate).not.toHaveBeenCalled()
+  })
+
+  it('returns error for oversize file without DB write', async () => {
+    const result = await requestUploadUrl(null, makeFormData({ fileSize: String(21 * 1024 * 1024) }))
+    expect(result).toMatchObject({ message: expect.any(String) })
+    expect(mockLabDocumentCreate).not.toHaveBeenCalled()
+  })
+
+  it('throws for unknown documentType (unhandled-branch discipline)', async () => {
+    await expect(
+      requestUploadUrl(null, makeFormData({ documentType: 'UNKNOWN_TYPE' })),
+    ).rejects.toThrow('Unknown documentType: UNKNOWN_TYPE')
+  })
+
+  it('creates LabDocument BEFORE calling generatePresignedPutUrl on happy path', async () => {
+    const callOrder: string[] = []
+    mockLabDocumentCreate.mockImplementation(async () => {
+      callOrder.push('create')
+      return mockDoc
+    })
+    mockGeneratePresignedPutUrl.mockImplementation(async () => {
+      callOrder.push('presign')
+      return 'https://presigned.example.com/put-url'
+    })
+
+    const result = await requestUploadUrl(null, makeFormData())
+    expect(callOrder).toEqual(['create', 'presign'])
+    expect(result).toMatchObject({ presignedUrl: expect.any(String), r2Key: expect.stringMatching(/^labs\/lab-1\//), labDocumentId: mockDoc.id })
+  })
+
+  it('returns error when presigning throws R2ValidationError and does NOT delete orphan row', async () => {
+    const { R2ValidationError } = await import('@/lib/storage/r2')
+    mockGeneratePresignedPutUrl.mockRejectedValue(new R2ValidationError('bad mime'))
+    const result = await requestUploadUrl(null, makeFormData())
+    expect(result).toMatchObject({ message: expect.any(String) })
+    expect(mockLabDocumentCreate).toHaveBeenCalledTimes(1)
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/labs/kyc-upload/__tests__/upload-action.test.ts
+++ b/src/features/labs/kyc-upload/__tests__/upload-action.test.ts
@@ -0,0 +1,108 @@
+// Unit tests for requestUploadUrl.
+// Mocks: Prisma (lab.findUnique, labDocument.create), auth, r2.generatePresignedPutUrl.
+// Covers: auth guard, lab ownership, MIME/size rejection before DB write, unknown documentType
+// throw, LabDocument creation before presigning, and orphan-row tolerance on R2 error. (ref: DL-013)
 import { describe, it, expect, vi, beforeEach } from 'vitest'

```


**CC-M-005-003** (src/features/labs/kyc-upload/__tests__/confirm-action.test.ts) - implements CI-M-005-003

**Code:**

```diff
--- a/src/features/labs/kyc-upload/__tests__/confirm-action.test.ts
+++ b/src/features/labs/kyc-upload/__tests__/confirm-action.test.ts
@@ -0,0 +1,97 @@
+import { describe, it, expect, vi, beforeEach } from 'vitest'
+
+const mockLabFindUnique = vi.fn()
+const mockLabDocumentUpdateMany = vi.fn()
+const mockLabUpdateMany = vi.fn()
+const mockTransaction = vi.fn()
+
+vi.mock('@/lib/auth', () => ({
+  auth: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    lab: { findUnique: mockLabFindUnique },
+    $transaction: mockTransaction,
+  },
+}))
+
+vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
+
+const { auth } = await import('@/lib/auth')
+const mockAuth = vi.mocked(auth)
+
+import { confirmUpload } from '../confirm-action'
+
+const labAdminSession = { user: { id: 'user-1', role: 'LAB_ADMIN' } }
+const mockLab = { id: 'lab-1', ownerId: 'user-1', kycStatus: 'PENDING' }
+
+function makeFormData(labDocumentId = 'doc-1') {
+  const fd = new FormData()
+  fd.set('labDocumentId', labDocumentId)
+  return fd
+}
+
+describe('confirmUpload', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mockAuth.mockResolvedValue(labAdminSession as ReturnType<typeof auth> extends Promise<infer T> ? T : never)
+    mockLabFindUnique.mockResolvedValue(mockLab)
+    mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
+      const tx = {
+        labDocument: { updateMany: mockLabDocumentUpdateMany },
+        lab: { updateMany: mockLabUpdateMany },
+      }
+      return callback(tx)
+    })
+    mockLabDocumentUpdateMany.mockResolvedValue({ count: 1 })
+    mockLabUpdateMany.mockResolvedValue({ count: 1 })
+  })
+
+  it('returns error for non-LAB_ADMIN session', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'user-1', role: 'CLIENT' } } as ReturnType<typeof auth> extends Promise<infer T> ? T : never)
+    const result = await confirmUpload(null, makeFormData())
+    expect(result).toMatchObject({ message: expect.any(String) })
+    expect(mockTransaction).not.toHaveBeenCalled()
+  })
+
+  it('returns error for ownership mismatch (lab not found)', async () => {
+    mockLabFindUnique.mockResolvedValue(null)
+    const result = await confirmUpload(null, makeFormData())
+    expect(result).toMatchObject({ message: expect.any(String) })
+    expect(mockTransaction).not.toHaveBeenCalled()
+  })
+
+  it('calls labDocument.updateMany with PENDING guard predicate', async () => {
+    await confirmUpload(null, makeFormData('doc-1'))
+    expect(mockLabDocumentUpdateMany).toHaveBeenCalledWith({
+      where: { id: 'doc-1', labId: 'lab-1', status: 'PENDING' },
+      data: { status: 'UPLOADED' },
+    })
+  })
+
+  it('early-returns without calling lab.updateMany when updateMany count is 0', async () => {
+    mockLabDocumentUpdateMany.mockResolvedValue({ count: 0 })
+    await confirmUpload(null, makeFormData())
+    expect(mockLabUpdateMany).not.toHaveBeenCalled()
+  })
+
+  it('calls lab.updateMany with kycStatus PENDING guard when count is 1', async () => {
+    await confirmUpload(null, makeFormData())
+    expect(mockLabUpdateMany).toHaveBeenCalledWith({
+      where: { id: 'lab-1', kycStatus: 'PENDING' },
+      data: { kycStatus: 'SUBMITTED' },
+    })
+  })
+
+  it('treats lab.updateMany count 0 as success (lab already SUBMITTED)', async () => {
+    mockLabUpdateMany.mockResolvedValue({ count: 0 })
+    const result = await confirmUpload(null, makeFormData())
+    expect(result).toBeNull()
+  })
+
+  it('returns null on success', async () => {
+    const result = await confirmUpload(null, makeFormData())
+    expect(result).toBeNull()
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/labs/kyc-upload/__tests__/confirm-action.test.ts
+++ b/src/features/labs/kyc-upload/__tests__/confirm-action.test.ts
@@ -0,0 +1,97 @@
+// Unit tests for confirmUpload.
+// Mocks: Prisma ($transaction, lab.findUnique, labDocument.updateMany, lab.updateMany), auth.
+// Covers: auth guard, ownership check, updateMany guard predicate, idempotent early-return
+// when count === 0, and atomic PENDING->UPLOADED + PENDING->SUBMITTED transition. (ref: DL-010, DL-013)
 import { describe, it, expect, vi, beforeEach } from 'vitest'

```


**CC-M-005-004** (src/features/payments/checkout/__tests__/kyc-gate.test.ts) - implements CI-M-005-004

**Code:**

```diff
--- a/src/features/payments/checkout/__tests__/kyc-gate.test.ts
+++ b/src/features/payments/checkout/__tests__/kyc-gate.test.ts
@@ -0,0 +1,144 @@
+import { describe, it, expect, vi, beforeEach } from 'vitest'
+import { KycStatus } from '@prisma/client'
+
+const mockOrderFindUnique = vi.fn()
+const mockTransactionFindFirst = vi.fn()
+const mockTransactionCreate = vi.fn()
+const mockCreateXenditInvoice = vi.fn()
+const mockCreateXenditVa = vi.fn()
+
+vi.mock('@/lib/auth', () => ({
+  auth: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    order: { findUnique: mockOrderFindUnique },
+    transaction: { findFirst: mockTransactionFindFirst, create: mockTransactionCreate },
+  },
+}))
+
+vi.mock('@/lib/payments/xendit', () => ({
+  createXenditInvoice: mockCreateXenditInvoice,
+  XenditApiError: class XenditApiError extends Error {},
+}))
+
+vi.mock('@/lib/payments/xendit-va', () => ({
+  createXenditVa: mockCreateXenditVa,
+  XenditVaError: class XenditVaError extends Error {},
+}))
+
+vi.mock('@/domain/payments/pesonet', () => ({
+  isPesonetBankCode: vi.fn().mockReturnValue(true),
+  PESONET_MIN_AMOUNT: 50000,
+}))
+
+vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
+
+const { auth } = await import('@/lib/auth')
+const mockAuth = vi.mocked(auth)
+
+import { initiateCheckout, initiateVaCheckout } from '../action'
+
+const clientSession = { user: { id: 'client-1', role: 'CLIENT' } }
+
+function makeOrder(kycStatus: KycStatus, extraLab: Record<string, unknown> = {}) {
+  return {
+    id: 'order-1',
+    clientId: 'client-1',
+    status: 'PAYMENT_PENDING',
+    quotedPrice: { toNumber: () => 100000 },
+    clientProfile: { email: 'client@example.com' },
+    service: { name: 'Test Service' },
+    lab: { id: 'lab-1', kycStatus, ...extraLab },
+  }
+}
+
+function makeCheckoutFormData() {
+  const fd = new FormData()
+  fd.set('orderId', 'order-1')
+  return fd
+}
+
+function makeVaFormData() {
+  const fd = new FormData()
+  fd.set('orderId', 'order-1')
+  fd.set('bankCode', 'BPI')
+  return fd
+}
+
+describe('KYC gate — initiateCheckout', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mockAuth.mockResolvedValue(clientSession as ReturnType<typeof auth> extends Promise<infer T> ? T : never)
+    mockTransactionFindFirst.mockResolvedValue(null)
+  })
+
+  for (const status of [KycStatus.PENDING, KycStatus.SUBMITTED, KycStatus.REJECTED] as const) {
+    it(`returns KYC error when kycStatus is ${status}`, async () => {
+      mockOrderFindUnique.mockResolvedValue(makeOrder(status))
+      const result = await initiateCheckout(null, makeCheckoutFormData())
+      expect(result).toMatchObject({ message: 'This lab is not yet verified. Payment cannot proceed.' })
+      expect(mockCreateXenditInvoice).not.toHaveBeenCalled()
+    })
+  }
+
+  it('KYC gate runs before idempotency check when PENDING transaction exists', async () => {
+    mockOrderFindUnique.mockResolvedValue(makeOrder(KycStatus.SUBMITTED))
+    mockTransactionFindFirst.mockResolvedValue({ id: 'tx-existing', checkoutUrl: 'https://checkout.xendit.co/existing' })
+    const result = await initiateCheckout(null, makeCheckoutFormData())
+    expect(result).toMatchObject({ message: 'This lab is not yet verified. Payment cannot proceed.' })
+    expect(mockCreateXenditInvoice).not.toHaveBeenCalled()
+  })
+
+  it('proceeds to Xendit when kycStatus is APPROVED', async () => {
+    mockOrderFindUnique.mockResolvedValue(makeOrder(KycStatus.APPROVED))
+    mockCreateXenditInvoice.mockResolvedValue({ invoiceId: 'inv-1', invoiceUrl: 'https://checkout.xendit.co/inv-1', rawResponse: {} })
+    mockTransactionCreate.mockResolvedValue({})
+    await initiateCheckout(null, makeCheckoutFormData())
+    expect(mockCreateXenditInvoice).toHaveBeenCalledTimes(1)
+  })
+
+  it('throws when order.lab is null after explicit include', async () => {
+    mockOrderFindUnique.mockResolvedValue({ ...makeOrder(KycStatus.PENDING), lab: null })
+    await expect(initiateCheckout(null, makeCheckoutFormData())).rejects.toThrow('referential integrity violation')
+  })
+})
+
+describe('KYC gate — initiateVaCheckout', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+    mockAuth.mockResolvedValue(clientSession as ReturnType<typeof auth> extends Promise<infer T> ? T : never)
+    mockTransactionFindFirst.mockResolvedValue(null)
+  })
+
+  for (const status of [KycStatus.PENDING, KycStatus.SUBMITTED, KycStatus.REJECTED] as const) {
+    it(`returns KYC error when kycStatus is ${status}`, async () => {
+      mockOrderFindUnique.mockResolvedValue(makeOrder(status))
+      const result = await initiateVaCheckout(null, makeVaFormData())
+      expect(result).toMatchObject({ message: 'This lab is not yet verified. Payment cannot proceed.' })
+      expect(mockCreateXenditVa).not.toHaveBeenCalled()
+    })
+  }
+
+  it('KYC gate runs before idempotency check when PENDING transaction exists', async () => {
+    mockOrderFindUnique.mockResolvedValue(makeOrder(KycStatus.SUBMITTED))
+    mockTransactionFindFirst.mockResolvedValue({ id: 'tx-existing', vaNumber: '1234567890' })
+    const result = await initiateVaCheckout(null, makeVaFormData())
+    expect(result).toMatchObject({ message: 'This lab is not yet verified. Payment cannot proceed.' })
+    expect(mockCreateXenditVa).not.toHaveBeenCalled()
+  })
+
+  it('proceeds to Xendit VA when kycStatus is APPROVED', async () => {
+    mockOrderFindUnique.mockResolvedValue(makeOrder(KycStatus.APPROVED))
+    mockCreateXenditVa.mockResolvedValue({ vaId: 'va-1', accountNumber: '1234567890', bankCode: 'BPI', externalId: 'tx-1', rawResponse: {} })
+    mockTransactionCreate.mockResolvedValue({})
+    await initiateVaCheckout(null, makeVaFormData())
+    expect(mockCreateXenditVa).toHaveBeenCalledTimes(1)
+  })
+
+  it('throws when order.lab is null after explicit include', async () => {
+    mockOrderFindUnique.mockResolvedValue({ ...makeOrder(KycStatus.PENDING), lab: null })
+    await expect(initiateVaCheckout(null, makeVaFormData())).rejects.toThrow('referential integrity violation')
+  })
+})

```

**Documentation:**

```diff
--- a/src/features/payments/checkout/__tests__/kyc-gate.test.ts
+++ b/src/features/payments/checkout/__tests__/kyc-gate.test.ts
@@ -0,0 +1,144 @@
+// Unit tests for the KYC gate in initiateCheckout and initiateVaCheckout.
+// Mocks: Prisma (order.findUnique, transaction.*), auth, xendit, xendit-va.
+// Covers: gate blocks all non-APPROVED statuses, gate preempts idempotency lookup,
+// APPROVED status proceeds to Xendit, and null lab throws referential-integrity error. (ref: DL-003, DL-011, DL-013)
 import { describe, it, expect, vi, beforeEach } from 'vitest'

```

