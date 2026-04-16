# dashboard/

## Files

| File        | What                                                                              | When to read                                                                      |
| ----------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `page.tsx`  | Async RSC — CLIENT auth guard, order fetch (no status filter), DTO                | Modifying auth gate, order fetch, or `ClientDashboardOrderDTO`                    |
| `ui.tsx`    | `'use client'` — flat table, status badge config, order detail links             | Modifying table columns, badge styling, or empty state                            |
| `README.md` | Auth guard, query strategy, DTO serialization constraints, badge exhaustiveness   | Understanding design decisions before modifying fetch or render logic             |
