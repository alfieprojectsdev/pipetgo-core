# test/

Shared vitest harness — DB provisioning, the test Prisma client, and module stubs
used across every test file.

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `global-setup.ts` | Runs once before the suite: loads `.env.test`, then `npx prisma db push` against `DATABASE_TEST_URL` so the test DB schema matches `prisma/schema.prisma` | Debugging "schema/column does not exist" failures; changing how the test DB is provisioned |
| `setup.ts` | Per-file setup: loads `.env.test` and hard-fails if `DATABASE_TEST_URL` is unset (refuses to touch a non-test DB) | Debugging missing-env failures |
| `test-prisma.ts` | `testPrisma` — a `PrismaClient` bound to `DATABASE_TEST_URL`; integration tests import this, never `@/lib/prisma` | Writing a real-DB integration test |
| `server-only-stub.ts` | No-op stand-in for the `server-only` package (see below) | Understanding why a module that `import 'server-only'` is testable |

## Running tests

Use `./scripts/test-local.sh` (repo root). It provisions a local `postgres:16-alpine`
container (`pipetgo-test-db`, host port 5433), re-syncs the generated Prisma client and
the DB schema to the current checkout, then runs vitest. The suite is offline — it does
**not** use the cloud Neon DB.

## Harness invariants & gotchas

- **`DATABASE_TEST_URL` (in `.env.test`) is the only DB the suite touches.** `.env.test`
  is gitignored, so a fresh clone or a new `wt/` worktree has none — `scripts/test-local.sh`
  writes a local default. The cloud Neon test DB is unreachable from local dev; do not
  point `DATABASE_TEST_URL` at it for routine runs.
- **No R2/S3 credentials are needed.** `src/lib/storage/__tests__/r2.test.ts` mocks the
  `@aws-sdk/client-s3` boundary and stubs its own env via `vi.stubEnv`; the
  "throws R2ConfigError when env vars are absent" case relies on R2 vars being **unset** in
  `.env.test`. Do not add `R2_*` to `.env.test`. A live MinIO/S3 is only for manual
  end-to-end upload testing, never the unit suite.
- **`server-only` is aliased to `server-only-stub.ts` in `vitest.config.ts`.** The real
  package throws when imported outside a React Server Component context; under vitest
  (node env) there is none, so any module doing `import 'server-only'` (e.g.
  `src/lib/storage/r2.ts`) would fail to load without the alias.
- **JSX uses the automatic runtime under vitest.** `tsconfig.json` sets `jsx: "preserve"`
  for Next; `vitest.config.ts` sets `esbuild: { jsx: 'automatic' }` so node-env tests that
  render a component do not throw "React is not defined".
- **`vi.mock` factories are hoisted above all top-level declarations.** Any value a factory
  references must come from `vi.hoisted(() => …)`, never a bare `const` — otherwise the
  factory hits a TDZ "Cannot access X before initialization". Set per-test return values
  (e.g. the auth session) inside `beforeEach`, where module-scope consts are in scope.
- **Worktrees share the generated Prisma client by default.** `wt/` worktrees resolve
  `node_modules` up to the main checkout, so all branches share one generated client. A
  worktree on a branch with a different `schema.prisma` will emit SQL for the wrong columns
  until `npx prisma generate` is re-run for it. `scripts/test-local.sh` always regenerates,
  so prefer it over a bare `npx vitest`.
- **The test DB schema is per-branch.** Switching the worktree/branch under test can require
  a destructive `prisma db push` (e.g. dropping an enum value another branch added).
  `scripts/test-local.sh` runs `db push --accept-data-loss` first (safe — fixtures are
  disposable) so `global-setup.ts`'s own non-destructive push then no-ops.
