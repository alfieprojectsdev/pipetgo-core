# accreditation-review — Design Decisions

## Slice origin — cloned from kyc-review (DL-001)

This slice is a sibling clone of `admin/kyc-review/`, not a parameterised extension.
`kyc-review/confirm-action` transitions `Lab.kycStatus` (the payment-gateway gate);
accreditation has no equivalent status enum — only the `isVerified` boolean. Parameterising
a single slice around `documentType` would couple the live KYC payment gate to a flow that
has no status transition, raising regression risk. The clone gives an independent copy with
no `kycStatus` coupling.

## Two-layer auth / TOCTOU (DL-007)

Every RSC page performs `auth()` and checks `session.user.role === 'ADMIN'` before data
access. `verifyOrRejectAccreditation` re-checks the same condition at execution time —
Server Actions are POST-invocable without navigating through any layout; the layout guard
does not protect them.

## kycStatus vs isVerified — independent lifecycles (C-002)

`Lab.kycStatus` is the **payment-gateway KYC gate** (T-15/T-13).
`Lab.isVerified` is the **ISO 17025 accreditation / marketplace-visibility gate** (T-18).
These are independent boolean and enum lifecycles. This slice reads and writes only
`isVerified` and the three accreditation audit columns — it never touches `kycStatus`.

## Boolean CAS verify transition (DL-004)

`verifyOrRejectAccreditation` writes the verified state via:
```ts
tx.lab.updateMany({ where: { id, isVerified: false }, data: { isVerified: true, … } })
```
`count === 0` means another admin already verified this lab — idempotent early-return without
overwriting. A bare `update` cannot detect a concurrent review.

The reject path guards `isVerified: false` to prevent a reject from reverting a lab that
was concurrently verified by another admin request between the read and write.

## Document cascade scoped to ACCREDITATION_CERTIFICATE (DL-005)

The cascade after a verify or reject is:
```ts
tx.labDocument.updateMany({
  where: { labId, documentType: 'ACCREDITATION_CERTIFICATE', status: 'UPLOADED' },
  data: { status: 'VERIFIED' | 'REJECTED' },
})
```
The `documentType` filter is mandatory. KYC docs and accreditation cert docs coexist in
the same `LabDocument` table. An unscoped cascade (`{labId, status: 'UPLOADED'}`) in either
slice advances documents of the other type — KYC docs getting cert status or certs getting
KYC status. The filter prevents cross-contamination. See the corresponding note in
`kyc-review/README.md`.

## Queue filter — no accreditationStatus enum (DL-003)

There is no `accreditationStatus` enum on `Lab`. The review queue derives pending state
from labs where `isVerified: false` AND at least one `LabDocument` with
`documentType: 'ACCREDITATION_CERTIFICATE'` and `status: 'UPLOADED'` exists. Ordered by
`Lab.createdAt asc` (creation time FIFO proxy — mirrors the KYC queue).

## On-click presigned GET (DL-004 pattern)

`viewAccreditationDocument` mints a 300s presigned GET URL on demand:
1. Re-checks `role === ADMIN`.
2. Loads `LabDocument.r2Key` via `findUnique` on `@unique id` — never derives the key from client input.
3. Calls `generatePresignedGetUrl(key)` — enforces the `labs/` prefix guard.
4. Returns `{ url }` for `window.open`.

Embedding URLs in the RSC payload would over-expose the credential for the full-page
lifetime and leak it into the Next.js router cache.

## Audit columns — latest-review-only (DL-009)

`accreditationReviewedById`, `accreditationReviewedAt`, `accreditationRejectionReason` on
`Lab` capture only the **latest** review. A re-review overwrites all three. Applied via
`npx prisma db push` (dev DB is push-managed; do not run `migrate dev`).

## Bootstrap — first verified lab (DL-010)

No lab has `isVerified=true` post-deploy. Preferred path: a `LAB_ADMIN` uploads a cert,
an `ADMIN` reviews it through this slice's verify flow. This exercises the real CAS path
and leaves an audit trail via `accreditationReviewedById/At`. Fallback: see the DevOps
checklist in `docs/roadmap.md`.
