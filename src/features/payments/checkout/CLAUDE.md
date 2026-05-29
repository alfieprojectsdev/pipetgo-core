# checkout/

Vertical slice: CLIENT with a PAYMENT_PENDING order initiates payment via Xendit invoice (`initiateCheckout`) or PESONet Fixed Virtual Account (`initiateVaCheckout`). Read `README.md` for the two-ID scheme, idempotency guard, and Xendit-first ordering invariants.

## Files

| File        | What                                                                                         | When to read                                                    |
| ----------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `page.tsx`  | Async RSC — authenticates, guards PAYMENT_PENDING status, maps Decimal to string, renders summary | Modifying auth gate, order fetch, or `CheckoutOrderDTO`    |
| `action.ts` | `initiateCheckout` — order guard, KYC gate (`Lab.kycStatus === APPROVED`), idempotency check, Xendit invoice creation, Transaction write, redirect to Xendit URL; `initiateVaCheckout` — same guard pattern plus bank code + amount validation, KYC gate, Xendit FVA creation, Transaction write with `vaNumber`, redirect to order-detail | Modifying either checkout flow, KYC gate, idempotency logic, or DB write |
| `ui.tsx`    | `'use client'` summary card — `useActionState`, Pay Now form, inline error display          | Modifying summary layout, error display, or button behaviour    |
