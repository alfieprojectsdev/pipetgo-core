# admin/

Admin-only feature slices. All slices under this directory are protected by
`session.user.role === 'ADMIN'` checks in both RSC pages and Server Actions (TOCTOU).

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `kyc-review/` | KYC document review — queue of SUBMITTED labs, per-lab detail, approve/reject CAS on `kycStatus` | Implementing or modifying the KYC review flow |
| `accreditation-review/` | ISO 17025 accreditation review — queue of unverified labs with an uploaded cert, verify/reject boolean CAS on `isVerified` | Implementing or modifying the accreditation review flow |
| `order-oversight/` | Read-only ADMIN oversight of all orders, their transactions, and payouts; cursor-paginated list + per-order detail with on-demand attachment download | Implementing or modifying order oversight |
