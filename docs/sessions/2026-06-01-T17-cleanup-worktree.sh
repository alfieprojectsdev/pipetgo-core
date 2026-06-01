#!/usr/bin/env bash
# Post-merge cleanup for T-18 (PR #18 merged as c1df6c1).
# Removes the worktree, then deletes the local + remote feature branch.
set -euo pipefail

cd /mnt/ssd/home/ltpt420/repos_finch/pipetgo-core

git worktree remove wt/T18-lab-verification --force
git branch -D feat/T18-lab-verification
git push origin --delete feat/T18-lab-verification

echo "=== worktrees ==="
git worktree list
echo "=== remote branch (should be empty) ==="
git ls-remote --heads origin feat/T18-lab-verification
