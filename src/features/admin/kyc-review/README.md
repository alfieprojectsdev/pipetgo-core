# kyc-review — Design Decisions

## Two-layer auth / TOCTOU (DL-001)

Every page performs an `auth()` call and checks `session.user.role === 'ADMIN'` before
any data access. Server Actions re-check the same condition at execution time — the page
gate alone is insufficient because an authenticated request can POST directly to the action
endpoint without navigating through any layout. This is the same dual-layer pattern used in
the lab-fulfillment slice.

## kycStatus vs isVerified — do not conflate (T-15 gotcha #3)

`Lab.kycStatus` (this slice) is the **payment-gateway verification gate**:
`PENDING` → `SUBMITTED` (T-15, first upload) → `APPROVED|REJECTED` (T-13, this slice).
A lab with `kycStatus=APPROVED` can receive payments through checkout.

`Lab.isVerified` is the **ISO 17025 accreditation / marketplace-visibility gate** (T-18).
These are independent lifecycles. This slice does not touch `isVerified`.

## kycStatus CAS transition (DL-002)

`approveOrRejectKyc` writes the new status via:
```ts
tx.lab.updateMany({ where: { id, kycStatus: 'SUBMITTED' }, data: { kycStatus: decision, … } })
```
`count === 0` means another admin already advanced the state → idempotent early-return without
overwriting the first decision. A bare `update` cannot detect a concurrent review and would
silently clobber whichever decision arrived second.

## SUBMITTED-only source state (DL-003)

Only `kycStatus === SUBMITTED` is a valid source state for a review action. The only permitted
transitions are `SUBMITTED → APPROVED` and `SUBMITTED → REJECTED`.

Any other observed source `KycStatus` (`PENDING`, `APPROVED`, or `REJECTED`) returns a
validation error rather than silently transitioning — approving a `PENDING` lab (no documents
submitted) or re-approving an already-decided lab are contract violations that would corrupt
the KYC audit trail. The CAS `where: { id, kycStatus: 'SUBMITTED' }` clause in
`tx.lab.updateMany` enforces this invariant at the query level: if the lab's current status
is not `SUBMITTED` the update matches zero rows (`count === 0`), triggering the idempotent
early-return without writing anything.

An unhandled or unexpected `decision` value (neither `APPROVED` nor `REJECTED`) throws / returns
a validation error and never defaults silently to a transition — per the CLAUDE.md
unhandled-states rule.

## On-click presigned GET (DL-004)

The detail RSC does **not** include `r2Key` in the DTO and does **not** embed presigned URLs
in the page payload. `viewKycDocument` mints a 300s presigned GET URL on demand:
1. Re-checks `role === ADMIN`.
2. Loads `LabDocument.r2Key` from the DB (server-trusted, never from client input).
3. Calls `generatePresignedGetUrl(key)` — enforces `labs/` prefix guard.
4. Returns `{ url }` for `window.open`.

Embedding the URL in the RSC payload would over-expose the credential for the full-page
lifetime and leak it into the Next.js router cache.

## Audit columns — latest-review-only (DL-005)

`kycReviewedById`, `kycReviewedAt`, `kycRejectionReason` on `Lab` capture only the **latest**
review. A re-review overwrites all three fields. A full review-history table was rejected as
disproportionate to the latest-only UX requirement (show rejection reason back to the lab).

## Queue ordering — lab creation order (DL-012)

`page.tsx` orders the SUBMITTED queue by `Lab.createdAt asc`. There is no `kycSubmittedAt`
column; `createdAt` (lab registration time) is the available proxy for queue age. FIFO on
creation time bounds worst-case wait for any revenue-blocked lab.

## Queue / detail split (DL-013)

The queue page is list-only (one row per SUBMITTED lab). The detail page shows a single lab
with per-document **View** links. This keeps the queue payload credential-free: presigned GET
URLs are minted on demand in `viewKycDocument`, not embedded in the queue RSC. An all-in-one
view would require minting every document URL up front, over-exposing credentials and breaking
the on-click 300s TTL (DL-004).

## First ADMIN — out-of-band bootstrap (DL-008)

No in-app admin-minting path exists. The first admin is bootstrapped via:
```sql
UPDATE "users" SET role = 'ADMIN' WHERE email = '<admin-email>';
```
Any in-app promotion path is a chicken-and-egg trust hole (who authorizes the first admin?).
Self-service role management is spun out as T-13b. See the DevOps checklist in
`docs/roadmap.md` for the required apply command.

## Migrations not committed (DL-011)

`prisma/migrations/` is gitignored. The Lab audit columns (`kycReviewedById`,
`kycReviewedAt`, `kycRejectionReason`, reviewer relation) are applied per-environment via
`npx prisma db push` (dev DB is push-managed; see devops-discipline.md). `schema.prisma` is the committed source of truth. A fresh or CI
environment missing this step gets a runtime crash on the audit fields, not a type error.
See the DevOps checklist in `docs/roadmap.md` for the required apply command.

## Doc cascade is scoped to KYC document types

`approveOrRejectKyc` cascades UPLOADED documents via
`{labId, status: 'UPLOADED', documentType: { in: KYC_DOCUMENT_TYPES }}`. The `documentType`
filter (`KYC_DOCUMENT_TYPES = ['BIR_2303', 'DTI_SEC', 'OTHER']`, mirroring the kyc-upload
allowlist) is required because `ACCREDITATION_CERTIFICATE` LabDocuments — and any future
LabDocument variety (T-12 attachments) — coexist in the same table for a lab. Without the
filter, a KYC approve/reject would advance a coexisting accreditation cert in `UPLOADED`
state to `VERIFIED`/`REJECTED`, and the accreditation-review queue (which reads
`{documentType: 'ACCREDITATION_CERTIFICATE', status: 'UPLOADED'}`) would then miss it.
The accreditation-review cascade is symmetrically scoped. (added in T-18 per CodeRabbit review)
