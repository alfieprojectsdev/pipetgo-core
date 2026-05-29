# kyc-upload slice

## Overview

Labs must pass payment-gateway KYC before any checkout can proceed. Without a checkout gate, every `PAYMENT_PENDING` order from any lab reaches Xendit invoice creation regardless of verification state — a business invariant violation, because PipetGo commits to settle into the lab's account and has no leverage to halt the flow once the invoice is paid. This slice adds a lab-level document store, a presigned PUT upload flow, and a KYC gate on both checkout paths.

## Architecture

Three actors and two external systems:

- **`upload-action.ts`** (Server Action): validates MIME/size, generates `r2Key`, creates a `LabDocument` row in `PENDING`, then calls `generatePresignedPutUrl`. Returns `{ presignedUrl, r2Key, labDocumentId }` to the client.
- **Browser (R2 PUT)**: `KycUploadUi` receives the presigned URL and PUTs the file directly to R2. No Next.js bottleneck.
- **`confirm-action.ts`** (Server Action): called by the client after a successful PUT. Inside a single `$transaction`, transitions `LabDocument PENDING → UPLOADED` and (if first upload) `Lab.kycStatus PENDING → SUBMITTED`.
- **`page.tsx` / `ui.tsx`**: RSC reads `Lab.kycStatus` and `LabDocument[]`, serializes dates, hands a DTO to the client component. Client renders the status badge and document list.
- **`src/features/payments/checkout/action.ts`**: Both `initiateCheckout` and `initiateVaCheckout` gate on `order.lab.kycStatus === APPROVED` before the Xendit call.

## Design Decisions

**New `LabDocument` model rather than nullable `Attachment.orderId` (DL-001):** `Attachment.orderId` is `NOT NULL`. Making it nullable would pollute every existing Attachment query with defensive null-handling and risk accidental fan-out. A dedicated `LabDocument` keyed on `labId` is strictly additive with no migration risk on existing rows.

**`Lab.kycStatus` separate from `Lab.isVerified` (DL-002):** `Lab.isVerified` is reserved for T-18 ISO 17025 accreditation — a distinct regulatory lifecycle. A boolean cannot represent `SUBMITTED` or `REJECTED` states. `KycStatus` gives the four-state lifecycle the manual verification path needs without conflating two independent regimes.

**Gate at checkout, not at settlement (DL-003):** By settlement time Xendit has already collected client funds. A gate there can only delay payout, not prevent the invoice. The checkout actions are the only point where no money has moved and rejection is safe.

**Xendit business-verification API deferred to T-13 (DL-004):** The Xendit endpoint shape is unverified — wiring it risks blocking every lab onboarding if the integration fails in sandbox. Manual admin verification ships with zero external-API risk; the `KycStatus` enum is already in place for Xendit to slot in later.

**Two-step upload: presigned PUT via browser (DL-005):** Vercel runtime caps Server Action FormData at 4.5 MB. KYC documents target 20 MB. Presigned PUT bypasses the cap; server bandwidth is not taxed.

**Server-generated `r2Key` (DL-006):** A client-supplied key allows cross-lab path traversal. The key `labs/{labId}/{cuid}.{ext}` is derived from the session-resolved `labId` — the client has no influence over it.

**`documentType` as `String` with server-side allowlist, not a Prisma enum (DL-016):** Philippine KYC document set is regulator-driven and will accrete. A Prisma enum forces a schema migration for every new document kind. A `String` column with a typed constant (`DOCUMENT_TYPE_ALLOWLIST` in `upload-action.ts`) allows catalog expansion without schema drift.

**Orphan rows and R2 objects tolerated (DL-018):** The two-step flow can leave a `PENDING` `LabDocument` row if the client abandons after `requestUploadUrl` but before PUT or confirm. A future GC ticket sweeps both the DB row and R2 object together: `status === PENDING AND createdAt < now - 24h` → Prisma delete + R2 `DeleteObject`. No cleanup logic belongs in this slice.

## Invariants

- `Lab.kycStatus` and `Lab.isVerified` are independent. T-15 owns `kycStatus`; T-18 owns `isVerified`. Never merge them.
- `Lab.kycStatus` transitions: `PENDING → SUBMITTED` (this slice, first confirmed upload) → `APPROVED | REJECTED` (T-13 admin only). This slice never writes `APPROVED`.
- `LabDocument.status` transitions: `PENDING` (row created) → `UPLOADED` (confirm fired) → `VERIFIED | REJECTED` (T-13 per-document review).
- Both `initiateCheckout` and `initiateVaCheckout` must include `lab: true` in the order lookup. A null `lab` after an explicit include must `throw`, not `notFound()` — it is a referential-integrity violation.
- All `LabDocument` and `Lab.kycStatus` state writes use `updateMany` with a guard predicate. `count === 0` is the idempotency / concurrent-write signal.
- `STATUS_BADGE` in `ui.tsx` uses `as const satisfies Record<KycStatus, …>`. A missing enum entry is a compile-time error.
