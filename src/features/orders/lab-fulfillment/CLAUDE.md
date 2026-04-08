# lab-fulfillment/

Vertical slice: LAB_ADMIN views an ACKNOWLEDGED or IN_PROGRESS order, begins
processing, and completes it with result notes. Read `README.md` for role
invariants, TOCTOU guard rationale, and transition ownership rules.

## Files

| File        | What                                                                                              | When to read                                                       |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `page.tsx`  | Async RSC — LAB_ADMIN auth, ownership guard, status guard, Decimal->string DTO, renders UI       | Modifying auth gate, order fetch, ownership check, or `LabOrderDTO` |
| `action.ts` | Two server actions — `startProcessing` (ACKNOWLEDGED->IN_PROGRESS) and `completeOrder` (IN_PROGRESS->COMPLETED); TOCTOU guards | Modifying transitions, notes write, or revalidation |
| `ui.tsx`    | `'use client'` — conditional rendering per status; `StartProcessingForm` and `CompleteOrderForm` with `useActionState` | Modifying form layout, error display, or notes textarea |
