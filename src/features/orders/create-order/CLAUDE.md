# create-order/

Vertical slice: CLIENT selects a `LabService` and submits a test request. Read `README.md` for serialization boundary rules, domain invariants, and the TOCTOU re-fetch pattern.

## Files

| File               | What                                                                                           | When to read                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `page.tsx`         | Async RSC — authenticates, fetches `LabService`, maps `Decimal` to `string`, renders form shell | Modifying auth gate, service fetch, or `CreateOrderServiceDTO`  |
| `action.ts`        | Server Action — validates, re-fetches service (TOCTOU), writes `Order` + `ClientProfile` in one transaction | Modifying validation, pricing logic, or DB write |
| `ui.tsx`           | `'use client'` form shell — `useActionState`, field layout, static pricing alerts             | Modifying form fields, error display, or submit button label    |
| `HybridToggle.tsx` | `'use client'` checkbox + conditional Alert for HYBRID pricing mode                           | Modifying HYBRID UX; isolated to prevent full-form re-renders   |
