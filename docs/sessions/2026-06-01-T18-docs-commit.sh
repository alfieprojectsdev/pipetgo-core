#!/usr/bin/env bash
# Commit + push T-18 doc updates (roadmap, session note, T-12 playbook, session git scripts) to main.
set -euo pipefail

cd /mnt/ssd/home/ltpt420/repos_finch/pipetgo-core

git add -- \
  docs/roadmap.md \
  docs/sessions/2026-06-01-T18-implementation-done.md \
  docs/sessions/2026-06-01_T-12-playbook.md \
  docs/sessions/2026-06-01_manual-git.sh \
  docs/sessions/2026-06-01-T17-cr-fix-git.sh \
  docs/sessions/2026-06-01-T17-merge-pr18.sh \
  docs/sessions/2026-06-01-T17-cleanup-worktree.sh \
  docs/sessions/2026-06-01-T18-docs-commit.sh

git commit -F .git-commit-msg-docs.txt
rm -f .git-commit-msg-docs.txt

git push origin main

echo "=== pushed; latest commit ==="
git log --oneline -1
