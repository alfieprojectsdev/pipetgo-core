# Session: V2 Foundation

**Date**: 2026-03-15
**Plan**: `plans/01-v2-foundation.md`
**Status**: Complete

## Milestones

### M-001: Prisma schema and folder scaffold

**Files created**:
- `prisma/schema.prisma` — 310 lines; 7 enums, 11 models, all relations and indexes
- `src/features/{orders,services,payments,labs,auth}/.gitkeep`
- `src/{app,components,lib,styles,domain}/.gitkeep`
- `package.json` — pins `prisma@^5.22.0`, `@prisma/client@^5.22.0`
- `.env` — placeholder `DATABASE_URL` (replace with real Neon URL before `prisma migrate`)

**Removed**: `src/features/quotations/` (non-conforming per DL-008)

**Acceptance criteria**:
- `npx prisma validate` — PASS (Prisma 5.22.0)
- All 11 M-001 constraints addressed in schema
- `src/domain/.gitkeep` present; `src/features/quotations/` absent

### M-002: Domain kernel and ESLint boundary rule

**Files created**:
- `src/domain/orders/state-machine.ts` — `validStatusTransitions` map + `isValidStatusTransition()`
- `src/domain/orders/client-details.ts` — `clientDetailsSchema` (Zod) + `ClientDetails` type
- `src/domain/orders/pricing.ts` — `resolveOrderInitialState()`
- `src/domain/payments/events.ts` — `PaymentCapturedEvent`, `PaymentFailedEvent`
- `eslint.config.js` — `no-restricted-imports` boundary rule for `src/domain/**`
- `src/domain/README.md`
- `tsconfig.json` — strict mode, `NodeNext`, `@/*` path alias

**Acceptance criteria**:
- `npx eslint src/domain/` — PASS
- `npx tsc --noEmit` — PASS
- Domain kernel line count: **154 lines** (budget: 300)

## Deviations from Plan

| ID | File | Issue | Fix |
|---|---|---|---|
| DEV-001 | `package.json` | No `package.json` existed; `npx prisma` defaulted to Prisma 7.5.0, which drops `url` from datasource blocks | Created `package.json` pinning `prisma@^5.22.0` |
| DEV-002 | `.env` | `DATABASE_URL` env var not set; `prisma validate` exits with P1012 | Added placeholder `DATABASE_URL` to `.env` |
| DEV-003 | `eslint.config.js` | `no-restricted-imports` `patterns` format changed in ESLint 9 — top-level `message` alongside `patterns` is rejected | Restructured to `patterns: [{ group, message }]` object form |
| DEV-004 | `eslint.config.js` | ESLint 9 cannot parse `.ts` files without a TypeScript parser | Added `typescript-eslint` and spread `tseslint.configs.recommended` |
| DEV-005 | `eslint.config.js` / `package.json` | `eslint.config.js` uses ESM `import`; Node warned about missing `"type": "module"` | Added `"type": "module"` to `package.json` |
| DEV-006 | `client-details.ts` | `\+`, `\(`, `\)` are unnecessary escapes inside a character class — `no-useless-escape` error | Changed regex to `/^[0-9\s\-+()]+$/` |

## Prisma Version Decision

The plan was authored against Prisma 5.x syntax (`@prisma/client/runtime/library` Decimal path, `url` in datasource block). Prisma 7.x (the `npx` default with no `package.json`) is a breaking-change release. **Prisma 5.22.0** was pinned. Reasons:

1. Plan's domain kernel imports `Decimal` from `@prisma/client/runtime/library` — path changed in Prisma 7
2. Prisma 7 requires `prisma.config.ts` for connection URLs — not accounted for in any plan slice
3. NextAuth Prisma adapter compatibility with Prisma 7 is unverified

## Next Steps

The next plan slice (`plans/02-*`) can assume:
- `prisma validate` passes; schema is the authoritative V2 data model
- Domain kernel is importable from feature slices via `@/domain/*`
- ESLint boundary rule is active — `src/domain/**` cannot import `@/features/*`
- `DATABASE_URL` in `.env` must be replaced with a real Neon connection string before `prisma migrate dev`
