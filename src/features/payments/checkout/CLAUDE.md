# checkout/

Vertical slice: CLIENT with a PAYMENT_PENDING order is redirected to Xendit-hosted
invoice. Read `README.md` for the two-ID scheme, idempotency guard, and Xendit-first
ordering invariants.

## Files

| File        | What                                                                                         | When to read                                                    |
| ----------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `page.tsx`  | Async RSC — authenticates, guards PAYMENT_PENDING status, maps Decimal to string, renders summary | Modifying auth gate, order fetch, or `CheckoutOrderDTO`    |
| `action.ts` | Server Action — TOCTOU guard, idempotency check, Xendit invoice creation, Transaction write | Modifying checkout flow, idempotency, or DB write               |
| `ui.tsx`    | `'use client'` summary card — `useActionState`, Pay Now form, inline error display          | Modifying summary layout, error display, or button behaviour    |
