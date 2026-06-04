#!/usr/bin/env bash
# Commit this session's notes + manual-git artifacts directly to main (session
# notes follow the direct-to-main convention; feature code/docs stay in PRs #21/#22).
set -euo pipefail

cd /mnt/ssd/home/ltpt420/repos_finch/pipetgo-core
test "$(git rev-parse --abbrev-ref HEAD)" = main || { echo "not on main"; exit 1; }

git add \
  docs/sessions/2026-06-04_T19-impl-and-local-test-infra.md \
  docs/sessions/2026-06-04_T19-commit-push-pr.sh \
  docs/sessions/2026-06-04_T19-test-fixes-push.sh \
  docs/sessions/2026-06-04_local-test-infra-push-pr.sh \
  docs/sessions/2026-06-04_session-notes-commit.sh

git commit -F - <<'EOF'
docs: session notes — T-19 impl + offline local test infrastructure (2026-06-04)

Session record for T-19 dispute/redress implementation (PR #21) and the offline
local test-infra work (PR #22): local Postgres container, vitest JSX/server-only
hardening, vi.mock hoisting fixes, and the wt/ worktree Prisma-client/DB gotchas.
Includes the manual-git artifacts used to push PRs #21/#22 this session.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF

git push origin main
