#!/usr/bin/env bash
# Manual git commands — update before running.
# Idempotent: each step is safe to re-run.
#   git add      — re-staging already-staged files is a no-op
#   git commit   — guarded by `git diff --cached --quiet ||`; skips if nothing staged
#   git push     — no-op if already up to date
#   gh pr merge  — errors gracefully if already merged
#
# Multiline commit message: one -m flag per paragraph.

git add docs/sessions/2026-05-26_T-20-playbook.md docs/sessions/2026-05-26_manual-git.sh
git diff --cached --quiet || git commit \
  -m "docs: T-20 playbook" \
  -m "Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push
