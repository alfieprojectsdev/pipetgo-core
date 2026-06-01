#!/usr/bin/env bash
# Commit + push T-12 plan + planning session note to main.
set -euo pipefail

cd /mnt/ssd/home/ltpt420/repos_finch/pipetgo-core

git add -- \
  plans/T-12-attachment-uploads.md \
  docs/sessions/2026-06-02-T12-planning-done.md \
  docs/sessions/2026-06-02-T12-plan-commit.sh

git commit -F .git-commit-msg-t12plan.txt
rm -f .git-commit-msg-t12plan.txt

git push origin main

echo "=== pushed; latest commit ==="
git log --oneline -1
