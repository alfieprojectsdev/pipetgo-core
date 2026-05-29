# labs/

Lab feature slices. Each subdirectory is a vertical slice scoped to one lab
workflow. Per VSA boundary rules (ADR-001), slices under labs/ must not import
UI components from other feature slices. (ref: DL-007)

## Files

No files at this level.

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `dashboard/` | Lab dashboard — LAB_ADMIN order listing with Incoming/Active/History tabs | Implementing or modifying the lab dashboard page |
| `wallet/` | Lab wallet dashboard — LabWallet balances and Payout history for LAB_ADMIN | Implementing or modifying the wallet page |
| `kyc-upload/` | KYC document upload — presigned PUT to Cloudflare R2, `Lab.kycStatus` lifecycle, checkout gate | Implementing or modifying KYC upload, checkout gate, or document list |
