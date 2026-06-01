#!/usr/bin/env bash
# Squash-merge PR #18 (T-18 lab accreditation verification) into main, delete branch.
# Green: CodeRabbit re-reviewed d0e8fc7 incrementally with 0 new comments; all 4
# original findings addressed; local tsc/eslint/105 tests clean.
set -euo pipefail

cd /mnt/ssd/home/ltpt420/repos_finch/pipetgo-core

gh pr merge 18 --squash --delete-branch

echo "=== state ==="
gh pr view 18 --json state,mergedAt -q '{s:.state,at:.mergedAt}'
