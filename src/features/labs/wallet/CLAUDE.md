# wallet/

Lab wallet dashboard slice. Displays LabWallet balances and paginated Payout history for LAB_ADMIN users.

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `page.tsx` | Async RSC — LAB_ADMIN auth guard, lab ownership guard, LabWallet + Payout fetch, DTOs | Modifying auth gate, balance fetch, Payout query, or DTO shape |
| `ui.tsx` | `'use client'` — three balance cards (Pending/Available/Withdrawn), Payout history table with status badges | Modifying balance display, table columns, or badge styles |

## Invariants

- `LabWallet` may be null (no completed orders yet) — rendered as zero balances, not 404.
- Payouts ordered newest-first (`orderBy: { createdAt: 'desc' }`); this is a read-only view, no client-side re-sort needed.
- `STATUS_BADGE` in `ui.tsx` uses `satisfies Record<PayoutStatus, …>` — adding a new `PayoutStatus` to the schema without a badge entry is a compile-time error, not a silent fallback.
