# T-17 Planning Session — Complete

**Date:** 2026-05-26  
**Branch to create:** `feat/T17-pesonet-virtual-account`  
**Plan file:** `plans/T-17-pesonet-virtual-account.md` (2,951 lines, QR-verified)  
**State dir (expired):** `/tmp/planner-avxmkq2l` — not needed for implementation

---

## What happened this session

Full planner orchestrator cycle completed (QR + TW phases) for T-17:
- plan-design QR: 30/30 PASS
- plan-code QR: 32/32 PASS (4 fix iterations)
- plan-docs QR: 12/12 PASS (2 fix iterations)

All 14 `code_changes` registered in plan.json. The plan file is the authoritative implementation spec — read it before starting.

---

## Implementation starting point

### Files to CREATE (new)
| File | What |
|---|---|
| `src/domain/payments/pesonet.ts` | `PESONET_MIN_AMOUNT = 50_000`, `PESONET_BANK_CODES`, `isPesonetBankCode()` |
| `src/lib/payments/xendit-va.ts` | `createXenditVa()` — POST `/callback_virtual_accounts` with `is_closed: true` |
| `src/features/payments/webhooks/xendit-va/types.ts` | `XenditVaPayload`, `normalizeXenditVaPayload()` |
| `src/features/payments/webhooks/xendit-va/route.ts` | VA webhook handler — dispatch on `COMPLETED`/`EXPIRED`/`FAILED` |
| `src/app/api/webhooks/xendit-va/route.ts` | `export { POST } from '@/features/payments/webhooks/xendit-va/route'` |
| `src/features/payments/webhooks/xendit-va/__tests__/normalize.test.ts` | Unit tests for normalizer |
| `src/features/payments/webhooks/xendit-va/__tests__/xendit-va.test.ts` | Unit tests for `createXenditVa` with mocked fetch |
| `src/features/payments/webhooks/xendit-va/__tests__/handlers.test.ts` | Integration tests: COMPLETED/EXPIRED/dedup/orphan |

### Files to MODIFY
| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `vaNumber String?` to Transaction after `checkoutUrl String?` |
| `src/lib/payments/types.ts` | Add `idempotencyKeyPrefix?: string` to `NormalizedWebhookPayload` |
| `src/features/payments/webhooks/handlers.ts` | Two one-liners only: `` `${payload.idempotencyKeyPrefix ?? 'xendit:invoice'}:PAID:${...}` `` and `...EXPIRED:${...}` |
| `src/features/payments/checkout/action.ts` | Append `initiateVaCheckout` export at end of file |
| `src/features/orders/order-detail/page.tsx` | Add Transaction include, add `vaNumber`/`transactionPaymentMethod` to DTO, render VA UI components |
| `src/features/orders/order-detail/ui.tsx` | Append `OrderDetailVaInstructions` and `OrderDetailVaBankSelector` client components |

---

## Critical gotchas discovered during planning

### 1. order-detail page has NO Transaction include (confirmed by file read)
Current Prisma query only includes `service`, `lab`, `clientProfile`. You must add:
```ts
transactions: { orderBy: { createdAt: 'desc' }, take: 1 }
```
`take: 1 desc` is intentional — retry scenario creates a second Transaction; always show the latest.

### 2. `initiateVaCheckout` lives in `checkout/action.ts`, imported by `order-detail/ui.tsx`
The bank selector in `ui.tsx` imports from `@/features/payments/checkout/action` (not `./action`). This is a cross-slice import — verify ADR-001 allows `features/orders` → `features/payments/checkout`. If the linter blocks it, add a re-export in `order-detail/action.ts`.

### 3. Xendit VA status strings differ from invoice
- Invoice webhook: `status = 'PAID'` / `'EXPIRED'`  
- VA webhook: `status = 'COMPLETED'` / `'EXPIRED'` / `'FAILED'`  
Do not reuse the invoice `switch` — use separate VA dispatch.

### 4. `expected_amount` must be `.toNumber()` not `.toFixed(2)`
Xendit FVA API requires a JSON number. `.toFixed(2)` returns a string and Xendit rejects it.

### 5. `NormalizedWebhookPayload.paymentMethod` for VA = bank_code string ('BPI', 'BDO', etc.)
Not a generic 'PESONET_VA' constant. The bank selector stores `bankCode` on Transaction at creation; the webhook normalizer also sets it via `bank_code` from the callback payload.

### 6. `handlers.ts` comment for idempotency key line
The existing comment says `(ref: DL-005)` — the one-liner change updates to `(ref: T-17 DL-004)`. Replace the comment, not just the string.

### 7. `idempotencyKeyPrefix` `??` fallback is intentional — not a silent failure
The `?? 'xendit:invoice'` fallback in `handlers.ts` is a rolling-deploy safety net, not an unhandled-state violation. Both route files explicitly set the prefix. Do not replace with a `throw`.

### 8. VA creation returns two IDs — store the right one
- `result.id` = Xendit's FVA ID → store as `Transaction.externalId`
- `result.account_number` = VA number shown to client → store as `Transaction.vaNumber`
- Our cuid = `Transaction.id` and also used as Xendit's `external_id` parameter at creation

### 9. Integration test seed requires real User FK for Lab.ownerId
Pattern: create User → create Lab with `ownerId: user.id` → create Order → create Transaction. No `email` field on Lab.create (not in schema). Mirror `handlers.test.ts` seed pattern exactly.

### 10. `prisma migrate dev` required after schema change
`vaNumber String?` is a nullable column — no default needed. Run `npx prisma migrate dev --name add-transaction-va-number` before testing.

---

## Implementation Discipline reminders (most common CodeRabbit findings)

- `updateMany` with status guard + `count === 0` check — never bare `update`
- `findUnique` on `@unique` fields — never `findFirst`
- `redirect()` after — never inside — try/catch in Server Actions
- Null relation after explicit `include` must `throw` — never `notFound()`
- RSC DTOs: `Decimal` → `.toFixed(2)` string, `Date` → `.toISOString()` string
- Rollback test mock names must match handler Prisma call exactly

---

## PR workflow

```bash
git checkout -b feat/T17-pesonet-virtual-account
# implement
npx tsc --noEmit         # must be clean
npm test -- --run        # all tests must pass
# open PR against main
```

PR title: `feat: T-17 — PESONet virtual account via Xendit FVA`
