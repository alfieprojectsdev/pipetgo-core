# dashboard/

## Files

| File       | What                                                                    | When to read                                                             |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `page.tsx` | Async RSC — LAB_ADMIN auth guard, lab ownership guard, order fetch, DTO; includes `QUOTE_REQUESTED` and `QUOTE_REJECTED` in query | Modifying auth gate, order fetch, ownership guard, or `LabDashboardOrderDTO` |
| `ui.tsx`   | `'use client'` — client-side tab switching; 4 tabs: Quoting/Incoming/Active/History; `OrderTable` sub-component | Modifying tab layout, table columns, sort order, or empty state |
| `README.md` | Architecture decisions, invariants, sort order, query guard rationale   | Understanding design decisions before modifying fetch or render logic    |
