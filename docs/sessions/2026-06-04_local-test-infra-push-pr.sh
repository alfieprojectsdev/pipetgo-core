#!/usr/bin/env bash
# Commit the local test-infra work (offline Postgres provisioning + vitest config
# hardening + two vi.mock hoisting fixes + docs) and open a PR against main.
set -euo pipefail

WT=/mnt/ssd/home/ltpt420/repos_finch/pipetgo-core/wt/local-test-infra
cd "$WT"

git add \
  vitest.config.ts \
  scripts/test-local.sh \
  src/test/server-only-stub.ts \
  src/test/CLAUDE.md \
  src/features/orders/lab-fulfillment/__tests__/action.test.ts \
  src/features/orders/order-detail/__tests__/action.test.ts \
  README.md \
  CLAUDE.md \
  docs/devops-discipline.md \
  docs/roadmap.md

git commit -F - <<'EOF'
chore: offline local test provisioning + vitest hardening + docs

Makes the full vitest suite runnable offline on a local Postgres container
(the cloud Neon test DB is unreachable from local dev). Suite goes from
9 failed files / 29 failed tests to 33 files / 267 tests all green.

- scripts/test-local.sh: provisions a postgres:16-alpine container
  (pipetgo-test-db, host port 5433), regenerates the Prisma client and
  db-pushes the schema for the CURRENT checkout, then runs vitest. The
  re-sync is what makes per-branch wt/ worktrees safe (shared node_modules
  means one generated client + one test DB across branches).
- vitest.config.ts: esbuild.jsx 'automatic' (fixes "React is not defined"
  in RSC-rendering tests) + a server-only alias to a no-op stub (makes
  src/lib/storage/r2.ts and its importers loadable under the node env).
- src/test/server-only-stub.ts: the no-op stub.
- Fix two pre-existing vi.mock hoisting bugs (TDZ on bare consts referenced
  in hoisted factories): lab-fulfillment and order-detail action tests now
  use vi.hoisted().
- Docs: README Testing section; root CLAUDE.md Development; new
  src/test/CLAUDE.md (harness + worktree gotchas); docs/devops-discipline.md
  (1 Pre-Flight line + 5 lessons); docs/roadmap.md (local dev/testing
  subsection + CI service-container note).

No R2/S3 service is needed locally — storage tests mock the AWS SDK boundary.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF

git push -u origin chore/local-test-infra

gh pr create \
  --base main \
  --head chore/local-test-infra \
  --title "chore: offline local test provisioning + vitest hardening + docs" \
  --body "$(cat <<'EOF'
## Summary

Makes the vitest suite runnable **offline** against a local Postgres container instead of the cloud Neon test DB (unreachable from local dev). Full suite: **9 failed files / 29 failed tests → 33 files / 267 tests, all green.**

### Provisioning
- **`scripts/test-local.sh`** — one idempotent command: create/start a `postgres:16-alpine` container (`pipetgo-test-db`, host port 5433), point `DATABASE_TEST_URL` at it, regenerate the Prisma client + `db push` the schema **for the current checkout**, then run vitest. The re-sync makes per-branch `wt/` worktrees safe (worktrees share one `node_modules` → one generated client + one test DB across branches).

### vitest config hardening
- `esbuild: { jsx: 'automatic' }` — fixes `React is not defined` in node-env component renders (`tsconfig` uses `jsx: "preserve"`).
- `resolve.alias['server-only']` → no-op stub (`src/test/server-only-stub.ts`) — makes `src/lib/storage/r2.ts` and its importers loadable under vitest.

### Test fixes (pre-existing bugs)
- `lab-fulfillment` and `order-detail` action tests referenced bare top-level consts inside hoisted `vi.mock` factories (TDZ `Cannot access X before initialization`). Converted to `vi.hoisted()`.

### Docs
- README **Testing** section; root **CLAUDE.md** Development; new **`src/test/CLAUDE.md`** (harness + worktree gotchas); **`docs/devops-discipline.md`** (1 Pre-Flight line + 5 lessons); **`docs/roadmap.md`** (local dev/testing subsection + CI service-container note).

## Notes
- No R2/S3 service needed locally — storage tests mock the `@aws-sdk/client-s3` boundary; `.env.test` must NOT set `R2_*` (one test asserts they are absent).
- `.env.test` is gitignored (machine-local); `scripts/test-local.sh` writes a local default if missing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
