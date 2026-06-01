#!/usr/bin/env bash
# Commit + push roadmap C-level refresh (T-12 plan written) to main.
set -euo pipefail

cd /mnt/ssd/home/ltpt420/repos_finch/pipetgo-core

git add -- docs/roadmap.md docs/sessions/2026-06-02-T12-roadmap-commit.sh

git commit -F .git-commit-msg-roadmap.txt
rm -f .git-commit-msg-roadmap.txt

git push origin main

echo "=== pushed; latest commit ==="
git log --oneline -1
