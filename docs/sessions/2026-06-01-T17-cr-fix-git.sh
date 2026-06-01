#!/usr/bin/env bash
# Commit + push T-18 CodeRabbit review fixes to the existing PR #18 branch.
set -euo pipefail

WT=/mnt/ssd/home/ltpt420/repos_finch/pipetgo-core/wt/T18-lab-verification
cd "$WT"

git add -- \
  src/features/admin/kyc-review/action.ts \
  src/features/admin/kyc-review/README.md \
  src/features/admin/kyc-review/__tests__/action.test.ts \
  src/features/admin/accreditation-review/view-document-action.ts \
  src/features/labs/accreditation-upload/ui.tsx \
  src/features/orders/create-order/__tests__/accreditation-gate.test.ts

git commit -F .git-commit-msg-T18-cr.txt
rm -f .git-commit-msg-T18-cr.txt

git push origin feat/T18-lab-verification

echo "=== pushed; latest commit ==="
git log --oneline -1
