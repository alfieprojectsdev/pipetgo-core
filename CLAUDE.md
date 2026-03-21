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
