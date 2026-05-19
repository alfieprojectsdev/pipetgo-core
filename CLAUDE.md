# PipetGo V2

Next.js lab testing marketplace. VSA + minimal domain kernel (see `README.md`).

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `README.md` | Project overview, V2 rationale, stack, invariants | Onboarding; architecture questions |
| `eslint.config.js` | Domain boundary `no-restricted-imports` rule | Modifying lint rules; debugging boundary violations |
| `tsconfig.json` | Strict TS, `@/*` → `src/*` alias | Changing compiler settings or path aliases |
| `package.json` | Dependencies; Prisma pinned at `^5.22.0` | Adding dependencies |

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `src/` | Features, domain kernel, app router, shared lib | Any code work |
| `src/features/` | Vertical slice feature directories | Implementing or modifying any user-facing feature |
| `src/domain/` | State machine, client schema, pricing, payment events | **Read `src/domain/README.md` first** — defines boundary rules and invariants |
| `docs/architecture/` | ADR-001, V1 state analysis | **Read `ADR-001-vertical-slice.md`** for architectural invariants and slice boundary rules |
| `prisma/` | `schema.prisma` — PostgreSQL data model | Schema changes; adding models |
| `plans/` | Implementation plans | Executing planned features |
| `docs/research/` | Pre-foundation drafts (some stale — see staleness notices) | Input when planning new slices |

## Development

```bash
npm install && npx prisma generate
npx tsc --noEmit && npx eslint src/domain/
```

## PR Workflow

Every plan implementation ships as a PR, not a direct push to `main`. CodeRabbit is installed on the repo and reviews automatically on every PR.

**Branch naming:** `feat/T{nn}-{slug}` — e.g. `feat/T01-auth-providers`

**Steps for each ticket:**
1. `git checkout -b feat/T{nn}-{slug}` from an up-to-date `main`
2. Implement the plan (write the plan file first if one doesn't exist)
3. `npx tsc --noEmit` — must be clean before opening PR
4. `npm test -- --run` — all tests must pass
5. Open PR against `main`; CodeRabbit reviews within minutes
6. Address any CodeRabbit blocking comments; re-request review
7. Squash-merge into `main`; delete the branch

**PR title format:** `feat: {ticket slug} — {one-line description}` matching the commit style already in this repo.

## The Compounding Protocol

After every 3–5 merged PRs, review the diffs and all review comments (CodeRabbit + internal quality-reviewer) across that batch. Identify the single most recurring pattern or architectural violation, then:

1. Write one imperative-style bullet for the **Implementation Discipline** section below — phrased as "X must Y" or "Never Z", with a real file path as a canonical example.
2. Commit the bullet directly to `main` with message `docs: compounding protocol — <pattern name>`.

**Trigger:** invoke by saying "run the Compounding Protocol" at any milestone. Last run after PR #11 (2026-05-19).

## Implementation Discipline

- **Unhandled states must throw, never default silently.** Every unhandled enum branch, `??` fallback, `indexOf(x) === -1` coercion, `parseFloat` on untrusted input, `findFirst` on a uniqueness invariant, and missing try/catch around Prisma must `throw new Error(...)` so contract violations surface in dev rather than producing wrong output in prod. See `src/lib/auth.ts` — `throw new Error('JWT token missing role')` — as the canonical example.
- **Prisma lookups on `@unique` fields must use `findUnique`, not `findFirst`.** `findFirst` silently picks an arbitrary row if the uniqueness invariant is ever violated; `findUnique` enforces the constraint at the query level and makes the lookup intent explicit. See `src/features/payments/webhooks/handlers.ts` — `tx.transaction.findUnique({ where: { externalId: payload.id } })` — as the canonical example.
- **Webhook state-transition writes must use `updateMany` with a guard predicate in `where` and check `count === 0` for concurrent-delivery early-return — never bare `update`.** A bare `update` cannot detect concurrent deliveries and silently overwrites a status already advanced by another request. `updateMany` with `{ id, guard_field: expected_value }` is the compare-and-set equivalent; `count === 0` means another delivery already advanced the state. See `src/features/payments/payouts/handlers.ts` — `tx.payout.updateMany({ where: { id, externalPayoutId: null } })` with `updateResult.count === 0` early-return — as the canonical example.
- **Enum dispatch tables must use `as const satisfies Record<EnumType, …>` — never `Record<string, …>` with a `??` fallback.** A `Record<string, …>` with `??` silently produces wrong output when a new enum member is added; `satisfies Record<EnumType, …>` makes a missing entry a compile-time error so schema evolution is caught at build time, not in production. See `src/features/labs/wallet/ui.tsx` — `STATUS_BADGE as const satisfies Record<PayoutStatus, { label: string; className: string }>` — as the canonical example.
- **After an explicit `include: { relation: true }` Prisma query, a null relation must throw — never call `notFound()`.** A missing relation after an explicit include is a referential-integrity violation, not a missing-row scenario; `notFound()` silently buries the failure in production monitoring. Split the guard: check `!order` → `notFound()`; check `!order.lab` → `throw new Error('Order.lab missing after explicit include — referential integrity violation')`; check ownership mismatch → `notFound()`. See `src/features/orders/quote-provide/page.tsx` — the compound `if (!order || !order.lab || ...)` guard — as the outstanding violation requiring the split. ⚠️ *Existing violation in `quote-provide/page.tsx` and `lab-fulfillment/page.tsx` — tracked for cleanup.*
- **Rollback tests using full Prisma mocks must name each mock method identically to the handler's Prisma call, and integration tests asserting a uniqueness invariant must use `findMany` + `expect(...).toHaveLength(1)` — never `findFirst`.** A misnamed mock (e.g., `payout.update` when the handler calls `payout.updateMany`) silently voids the test's error-propagation assertion; `findFirst` in assertions masks duplicate-record bugs. See `src/features/payments/payouts/__tests__/handlers-rollback.test.ts` — `mockPayoutUpdateMany` aligned to `tx.payout.updateMany(...)` — as the canonical example.
- **RSC page components must serialize all `Prisma.Decimal` fields via `.toFixed(2)` and all `Date` fields via `.toISOString()` before passing data to client components — never pass raw Decimal or Date objects across the RSC boundary.** Next.js cannot serialize these types; the failure is a runtime crash, not a type error. DTO field types must reflect the serialized form (`amount: string`, not `amount: Decimal`). See `src/features/labs/wallet/page.tsx` — `LabWalletDTO` and `LabPayoutDTO` with all Decimal and Date fields typed as `string` — as the canonical example.
- **In Server Action Prisma `update` calls, use `?? null` — never `|| undefined` — for optional fields that should be clearable.** `formData.get('field') || undefined` produces `undefined` when the input is blank; Prisma treats `field: undefined` as "skip this field", silently preserving the old value instead of clearing it. `?? null` writes SQL NULL as intended. See `src/features/labs/service-management/action.ts` — `description: description ?? null` — as the canonical example.
- **`redirect()` must always be called after — never inside — any `try/catch` block in Server Actions.** Next.js implements `redirect()` by throwing a `NEXT_REDIRECT` error internally; a surrounding `catch` swallows it and the action returns normally instead of navigating. See `src/features/payments/checkout/action.ts` — `redirect(checkoutUrl)` as the last statement after the try/catch exits — as the canonical example.
