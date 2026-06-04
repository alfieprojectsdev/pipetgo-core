# DevOps Readiness Protocol

Implementation quality has machinery — the planner, the Compounding Protocol, and the
Implementation Discipline list in `CLAUDE.md`. The **environment** path has none, which is
why provisioning gaps surface all at once *right after* code is confidently "done": nothing
forced the environment checks earlier, and nothing accumulated the lessons.

This protocol closes that gap with **two arms**:

- **Pre-Flight Checklist** (proactive) — run before any "run / verify / deploy merged code"
  step, so latent environment gaps surface *before* they block you.
- **DevOps Discipline** (reactive) — an append-only list of `cause → symptom → fix` lessons.
  Each new lesson sharpens a Pre-Flight line, so the same class of bottleneck is caught
  proactively next time instead of rediscovered.

> Compounding Protocol extracts **code** patterns from merged PR diffs (home: `CLAUDE.md`
> Implementation Discipline). This protocol extracts **environment** gotchas from session-time
> provisioning blockers (home: this file). Compounding runs every 3–5 PRs; this runs
> event-driven — whenever provisioning blocks a session — plus a sweep at each phase boundary.

---

## Pre-Flight Checklist

Run this **before** trying to run, verify, screenshot, or deploy merged code — i.e. at the
exact `code-done → make-it-actually-run` boundary where the bottlenecks live.

- [ ] **Deps installed for THIS checkout.** A fresh clone or `wt/` worktree has no
  `node_modules`, and `package.json` deps can have drifted even in the main checkout.
  `npm install`; confirm the Prisma client is generated (`npx prisma generate`).
  *Skip-symptom:* missing-module 500s at first request (e.g. `Cannot find module 'tailwindcss'`).
- [ ] **DB reachable from THIS shell, schema applied for THIS env.** Is `DATABASE_URL` loaded
  in this shell? `npx prisma migrate status`. Apply per the env's workflow — in this repo
  `npx prisma db push` (NOT `migrate dev`; see Discipline #3). *Skip-symptom:* runtime crash
  on a column that exists in `schema.prisma` but not the DB.
- [ ] **Required env vars present via the framework's full env-file chain.** Load `.env.local`
  AND `.env` (Next loads both, local first); never conclude a var is missing from `.env`
  alone. `node --env-file=.env --env-file=.env.local -e '…'` to assert presence by name —
  never echo secret values.
- [ ] **Dedicated port free or pinned.** `lsof -ti:PORT` empty, or pass `--port NNNN` you own.
  A foreign process on the default port makes the dev server silently bump to the next port;
  curling the default port then hits a different app. *Skip-symptom:* "it renders wrong /
  unstyled / 404s" that is actually a different server answering.
- [ ] **Identity / data prerequisites exist before any state or role mutation.** A promote /
  seed `UPDATE` on an empty table is a 0-row no-op. Provision the row first (e.g. OAuth
  sign-in creates the `User`), THEN mutate. Pre-seeding identity rows can break provider
  account-linking — prefer provision-then-mutate.
- [ ] **External services configured for THIS origin.** R2 CORS allows your origin; the OAuth
  redirect URI is registered for `http://localhost:PORT/api/auth/callback/<provider>`.
  *Skip-symptom:* uploads or sign-in fail only at runtime, with nothing wrong in the code.
- [ ] **Tests run offline against a local DB, with the client + schema synced to THIS branch.**
  Use `./scripts/test-local.sh` — it provisions the local Postgres container, regenerates the
  Prisma client, and `db push`es the schema for the current checkout before vitest. Do NOT
  rely on the cloud test DB (unreachable locally), and do NOT run a bare `npx vitest` in a
  `wt/` worktree. *Skip-symptom:* `P1001` to a Neon host, or `column X does not exist` because
  a sibling worktree's shared generated client emits SQL for another branch's schema.

When a new lesson is captured below, add or sharpen the corresponding line here.

---

## DevOps Discipline

Append-only. Each bullet: **imperative rule** — `cause → symptom → fix`, with a real example.
Newest at the bottom.

- **Pin the dev-server port and confirm it is yours before trusting what you curl.** Another
  project's server can already hold the default port; the framework prints "Port X is in use,
  trying X+1" and moves on, so requests to the default port reach a foreign app. The result
  read as "the app serves no CSS" when in fact a different server was answering. Fix: launch
  on a port you own (`npx next dev --port NNNN`) or verify `lsof -ti:3000` is empty/yours, and
  read the startup log for the actually-bound port. *(2026-05-31, T-13 deploy: a stray
  `next-server v16` from another project squatted :3000.)*
- **Verify declared infra deps are actually installed before running.** `package.json` can
  declare a build-critical dep that is absent from `node_modules` (fresh checkout, or a
  partial install). `tailwindcss` + `autoprefixer` were declared but uninstalled, so every
  route 500'd on the `globals.css` Tailwind import — not a code bug. Fix: `npm install` at
  session start in any fresh/worktree checkout; if a build tool errors with `Cannot find
  module`, check `test -d node_modules/<dep>` before debugging the code. *(2026-05-31, T-13.)*
- **Never `prisma migrate dev` against a `db push`-managed database.** If the dev DB was
  advanced with `db push` (gitignored migrations, no migration history for some models),
  `migrate dev` detects drift and offers a **destructive reset**. Confirm the workflow first
  (`prisma migrate status` + look for a model with no migration file); apply additive nullable
  columns with `npx prisma db push`. `schema.prisma` is the committed source of truth.
  *(2026-05-31, T-13: dev Neon DB had T-15's `LabDocument` with no migration → `db push` used.)*
- **Load the framework's full env-file chain before declaring a variable missing.** Checking
  only `.env` falsely flagged `AUTH_GOOGLE_ID`/`AUTH_SECRET` as absent — they live in
  `.env.local`, which Next loads ahead of `.env`. Fix: mirror the framework's load order when
  asserting env presence (`node --env-file=.env --env-file=.env.local`). *(2026-05-31, T-13.)*
- **Per-environment migration and bootstrap are owed, recurring work — not one-and-done.**
  Gitignored migrations (DL-011) mean each environment (local / CI / each Neon branch / prod)
  needs its own schema apply, and the first-admin bootstrap (DL-008) is per-env manual SQL.
  Track these as explicit per-env checklist items; do not assume "merged" means "applied
  everywhere." *(2026-05-31, T-13: dev applied; CI/prod still owe it.)*
- **Provision identity before mutating role or state.** A privilege/state write cannot land on
  an environment that has no rows yet. The admin-promote `UPDATE` hit 0 rows because no `User`
  existed until the founder's first OAuth sign-in (NextAuth creates the row on sign-in;
  pre-seeding a bare `User` breaks OAuth account-linking). Sequence: provision the identity →
  THEN grant/mutate. *(2026-05-31, T-13 admin bootstrap.)*
- **Run the test suite against a local DB container, not the cloud test DB.** The cloud Neon
  test DB is unreachable from local dev, so the whole suite (even pure unit tests) dies in
  `global-setup`'s `prisma db push` with `P1001`. Fix: a local `postgres:16-alpine` container
  on a non-default port (5433, since dev Postgres holds 5432) + `DATABASE_TEST_URL` pointing at
  it; `scripts/test-local.sh` provisions and runs it. *(2026-06-04, T-19 local-test session.)*
- **A `wt/` worktree shares ONE generated Prisma client and ONE test DB across branches —
  re-sync both to the current checkout before testing.** Worktrees resolve `node_modules` up
  to the main checkout, so whichever branch last ran `prisma generate` wins; a worktree on a
  branch with a different `schema.prisma` then emits SQL for the wrong columns
  (`column orders.completedAt does not exist`). The single test DB likewise carries whatever
  schema was last pushed, and a branch switch can need a destructive `db push` (dropping an
  enum value another branch added). Fix: `scripts/test-local.sh` runs `prisma generate` +
  `db push --accept-data-loss` (fixtures are disposable) for the current checkout first.
  *(2026-06-04, T-19: main-branch worktree inherited T-19's client + DISPUTED-enum DB.)*
- **A module that `import 'server-only'` is untestable under vitest until the package is
  aliased to a no-op.** `server-only` throws outside a React Server Component context; the
  node-env test runner has none, so any importer (`src/lib/storage/r2.ts`) fails to load —
  even its pure export tests. Fix: `resolve.alias['server-only']` → an empty stub in
  `vitest.config.ts`. *(2026-06-04, T-19: 17 r2 tests failed on the bare `import 'server-only'`.)*
- **Tell esbuild the JSX runtime explicitly for vitest, or component renders throw "React is
  not defined".** `tsconfig.json` uses `jsx: "preserve"` (Next handles JSX); vitest's esbuild
  then defaults to the classic runtime and emits `React.createElement` with no React in scope.
  Fix: `esbuild: { jsx: 'automatic' }` in `vitest.config.ts`. *(2026-06-04, T-19: RSC-rendering
  tests across browse/order-oversight failed before the suite could assert anything.)*
- **`vi.mock` factories are hoisted above all top-level code — reference only `vi.hoisted()`
  values, never bare consts.** A factory that reads a module-scope `const` (an id, a mock fn)
  hits a TDZ `Cannot access X before initialization` and fails the whole file to load. Fix:
  declare the value via `const x = vi.hoisted(() => …)`; set per-test data (e.g. the auth
  session) in `beforeEach`. *(2026-06-04, T-19: lab-fulfillment + order-detail action tests.)*

---

## Extraction protocol (the reactive arm)

After any session where a provisioning or environment issue blocked running or verifying
merged code:

1. Write **one DevOps Discipline bullet** above — `cause → symptom → fix` with a real example
   and a dated reference.
2. If it is pre-flight-checkable, **add or sharpen a Pre-Flight Checklist line** so it is
   caught proactively next time.
3. Commit directly to `main` with message `docs: devops protocol — <lesson name>`.

**Trigger:** invoke by saying "run the DevOps Readiness Protocol", or whenever a
provisioning/environment issue blocks a session after code is confidently merged.

**Last run:** 2026-06-04 (T-19 local-test session — 5 lessons: local test DB container,
worktree client/DB drift, `server-only` alias, vitest JSX runtime, `vi.mock` hoisting).
Prior: seeded 2026-05-31 (T-13 local-deploy session — 6 lessons).
