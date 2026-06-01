# T-20 Planning Session — Complete

**Date:** 2026-05-26  
**Branch to create:** `feat/T20-privacy-compliance`  
**Plan file:** `plans/T-20-privacy-compliance.md` (QR-verified, all phases)  
**State dir (expired):** `/tmp/planner-7xrdv3w1` — not needed for implementation

---

## What happened this session

Full planner orchestrator cycle completed (QR + TW phases) for T-20:
- plan-design QR: PASS (carried over from prior session — 2 fix iterations)
- plan-code QR: PASS (4 fix iterations — hunk header accuracy + hidden-input coercion pattern + enum-drift guard shape)
- plan-docs QR: PASS (3 fix iterations — temporal language, planning artifact refs, DL anchoring)

7 `code_changes` registered in plan.json across 1 milestone (M-001). The plan file is the authoritative implementation spec — read it before starting.

---

## Implementation starting point

### Files to CREATE (new)
| File | What |
|---|---|
| `src/app/privacy/page.tsx` | Static RSC — no auth; 7-section privacy notice with legal-review comment at top |
| `src/domain/orders/__tests__/client-details.test.ts` | Unit tests: 3-case z.literal(true) fence + 2-case enum-drift fence for SENSITIVE_SERVICE_CATEGORIES |

### Files to MODIFY
| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `consentGiven Boolean @default(false)` + `consentGivenAt DateTime?` to `ClientProfile` after `address String?` |
| `src/domain/orders/client-details.ts` | Append `consentGiven: z.literal(true)` to schema; add `SENSITIVE_SERVICE_CATEGORIES as const satisfies Record<ServiceCategory, boolean>` + `isSensitiveServiceCategory()`; import `ServiceCategory` from `@prisma/client` |
| `src/features/orders/create-order/action.ts` | Add `consentGiven: formData.get("consentGiven") === "true" ? true : undefined` to rawDetails; add `consentGiven: true, consentGivenAt: new Date()` inside `tx.clientProfile.create` |
| `src/features/orders/create-order/ui.tsx` | Add `useState<boolean>(false)` for consent; add hidden input + native checkbox + `/privacy` link block after address, before global error alert |
| `src/features/orders/create-order/README.md` | Append "RA 10173 Privacy Compliance" section under Invariants |
| `src/domain/orders/CLAUDE.md` | Update `client-details.ts` row to mention `SENSITIVE_SERVICE_CATEGORIES` + `isSensitiveServiceCategory` |

---

## Critical gotchas discovered during planning

### 1. `z.literal(true)` — not `z.boolean()` — is the regulatory gate
`z.boolean()` accepts `false`; an unchecked box would pass `safeParse` with `consentGiven: false` and the action would persist an unconsented ClientProfile. `z.literal(true)` makes `false` and `undefined` both Zod parse failures, surfacing as `errors.consentGiven`. This is a MUST per the constraints; the unit test has two rejection cases specifically to catch a future downgrade to `z.boolean()`.

### 2. Coercion string must be `=== "true"` — not `=== "on"`
Native HTML checkboxes send `"on"` when checked and are absent from `FormData` when unchecked. The plan uses a hidden-input pattern (mirroring `HybridToggle`): `<input type="hidden" name="consentGiven" value={String(consentGiven)}>` always sends `"true"` or `"false"`. The action coerces with `=== "true"` — not `=== "on"`. Using `"on"` would silently fail to coerce the hidden input's value.

### 3. Consent fields go inside the existing `$transaction` — no second write
`consentGiven: true` and `consentGivenAt: new Date()` are added to the `data` block of `tx.clientProfile.create`, not in a separate `prisma.clientProfile.update`. A separate write would break the Order+ClientProfile atomicity boundary documented in the slice README. `consentGivenAt` is `new Date()` in the action — never a client-supplied value (prevents timestamp spoofing).

### 4. `SENSITIVE_SERVICE_CATEGORIES` uses `as const satisfies Record<ServiceCategory, boolean>`
The Implementation Discipline rule for enum dispatch tables requires `satisfies Record<EnumType, …>` — not `Record<string, …>`. Missing a member (e.g., adding `GENETIC_TESTING` to the enum in future) fails `npx tsc --noEmit` immediately. The accompanying runtime test (`Object.keys(SENSITIVE_SERVICE_CATEGORIES).sort()` deep-equals `Object.values(ServiceCategory).sort()`) closes the gap if the `satisfies` guard is ever accidentally cast away.

### 5. Migration is local only — `prisma/migrations/` is gitignored
Same convention as T-16 and T-17. Run `npx prisma migrate dev --name add-client-profile-consent` locally before `npm test -- --run`. The PR commits only `schema.prisma`. Do not commit the migration directory.

### 6. `/privacy` must be a public RSC — no auth gate
The consent checkbox links to `/privacy` via `target="_blank"` before the user completes authentication (it's on the create-order form). If `/privacy` is accidentally placed behind an auth layout, clients cannot read the notice. Verify `src/app/privacy/page.tsx` is not inside any auth-gated layout group.

### 7. `redirect()` placement — must remain after try/catch
`createOrder` in `action.ts` already has `redirect()` calls outside any try/catch (Implementation Discipline rule #9). The plan adds two fields to the `tx.clientProfile.create` block inside the `$transaction` — do not inadvertently move the `redirect()` calls or wrap them.

### 8. Pre-T-20 ClientProfile rows are deliberately left with `consentGiven=false`
V2 has processed zero commercial transactions; all existing rows are dev seeds. Backfilling them with `consentGiven=true` would fabricate a consent event that never happened — a RA 10173 violation. Accepted gap per DL-012; seed-data reset is a Phase-4 release prerequisite.

### 9. Consent revocation/withdrawal is T-21 — not in scope here
RA 10173 §34 (prospective withdrawal) requires non-trivial logic around in-flight orders and contract-performance lawful basis (§12(b)). `consentGiven` is write-once at order creation. Do not add any post-creation mutation of `consentGiven` in this ticket.

---

## Implementation Discipline reminders

- `z.literal(true)` on `consentGiven` — never `z.boolean()` (DL-002)
- `redirect()` after — never inside — try/catch in Server Actions
- RSC DTOs: `Decimal` → `.toFixed(2)` string, `Date` → `.toISOString()` string (not applicable here — privacy page has no Prisma data, but watch if adding consentGivenAt to any DTO)
- Enum dispatch tables must use `as const satisfies Record<EnumType, …>` (DL-011)
- Unhandled states must `throw`, never default silently

---

## PR workflow

```bash
# 1. Apply migration locally first
npx prisma migrate dev --name add-client-profile-consent

# 2. Branch and implement
git checkout -b feat/T20-privacy-compliance

# 3. Verify before PR
npx tsc --noEmit          # must be clean
npx eslint src/           # must be clean
npm test -- --run         # all tests must pass

# 4. Open PR against main
```

PR title: `feat: T-20 — RA 10173 privacy compliance (consent checkbox + privacy page)`
