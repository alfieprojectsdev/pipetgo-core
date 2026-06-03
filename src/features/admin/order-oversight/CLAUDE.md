# order-oversight/

Read-only ADMIN oversight of all platform orders, their transactions, and payouts.

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `page.tsx` | RSC list page — cursor-paginated, PII-minimized (DL-002); renders `AdminOrderListUi` | Modifying list query, pagination, or DTO shape |
| `ui.tsx` | `AdminOrderListUi` — table with status badges, Prev/Next cursor links | Modifying list table layout |
| `detail-page.tsx` | RSC detail page — full order with transactions, payouts, attachments; renders `AdminOrderDetailUi` | Modifying detail data shape, relation guards, or DTO |
| `detail-ui.tsx` | `AdminOrderDetailUi` — order header, client PII section, transactions table, payouts table, attachment list | Modifying detail layout |
| `view-attachment-action.ts` | `viewOrderAttachment` — ADMIN-gated (DL-004, DL-005); mints 300s presigned GET for an attachment | Modifying attachment download |
| `attachment-list-ui.tsx` | `AttachmentListUi` — renders attachment list with on-click View (window.open before await) | Modifying attachment UI |
| `README.md` | Invisible-knowledge design decisions | Before changing auth, pagination, PII policy, or attachment access |

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `__tests__/` | Unit tests for `view-attachment-action.ts`, list page, and detail page | Adding or debugging tests |

## Invariants

- Slice is strictly read-only — zero write paths (no update/create/delete/upsert).
- ADMIN role re-checked independently in every RSC page and Server Action — layout guard is layer 1 only (TOCTOU, DL-005).
- List view surfaces PII-minimized fields only; full ClientProfile visible in detail behind the ADMIN gate (DL-002, RA 10173).
- ADMIN access requires a bootstrapped ADMIN user — no in-app role promotion path exists.
