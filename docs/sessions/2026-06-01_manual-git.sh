#!/usr/bin/env bash
# Manual git ops for T-18 lab accreditation verification.
# Commits the already-staged tree on feat/T18-lab-verification, pushes, opens PR.
set -euo pipefail

WT=/mnt/ssd/home/ltpt420/repos_finch/pipetgo-core/wt/T18-lab-verification
cd "$WT"

echo "=== branch ==="
git branch --show-current

echo "=== commit (staged tree, msg file excluded) ==="
git commit -F .git-commit-msg-T18.txt
rm -f .git-commit-msg-T18.txt

echo "=== push ==="
git push -u origin feat/T18-lab-verification

echo "=== open PR ==="
gh pr create \
  --base main \
  --head feat/T18-lab-verification \
  --title "feat: T-18 lab accreditation verification — ISO 17025 isVerified gate" \
  --body "$(cat <<'BODY'
## T-18 — ISO 17025 lab accreditation verification gate

Adds a marketplace verification gate (`Lab.isVerified`) that is **independent** of the
existing payment KYC gate (`Lab.kycStatus`). Implements the ITA 2023 solidary-liability
control: only accredited labs surface in the marketplace and can receive orders.

### Slices (cloned from T-13 KYC pattern)
- `labs/accreditation-upload/` — lab uploads ISO 17025 certificate (presigned R2 PUT, two-step confirm via CAS)
- `admin/accreditation-review/` — admin verifies/rejects with concurrent-admin compare-and-set

### Gates
- `services/browse` — `findMany` filter `lab: { isVerified: true }` (read/UX gate)
- `orders/create-order` — reject `if (!service.lab.isVerified)` **before** `$transaction` (security-critical write gate)

### Schema
- `Lab`: `accreditationReviewedById`, `accreditationReviewedAt`, `accreditationRejectionReason` + reviewer relation
- Applied to dev DB via `npx prisma db push` (audit columns; tracked in `docs/roadmap.md`)

### Invariants enforced
- T-18 code writes ONLY `isVerified` + accreditation audit columns — never `kycStatus`
- Concurrent-admin CAS: `updateMany` guard + `count === 0` early-return (verify, reject, confirm)
- Document cascade scoped to `documentType: 'ACCREDITATION_CERTIFICATE'` — coexisting KYC docs untouched
- All `formData.get()` boundary-narrowed; `redirect()` after try/catch; Date DTO fields `.toISOString()`

### Verification
- `npx tsc --noEmit` clean
- 105 unit tests pass
- Internal quality-reviewer: PASS_WITH_CONCERNS — the one SHOULD finding (`fileSizeRaw` typeof-narrowing) was fixed before commit

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"

echo "=== PR URL ==="
gh pr view --json url -q .url
