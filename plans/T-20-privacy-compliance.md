# Plan

## Overview

ClientProfile collection at order creation has no consent record; RA 10173 (Data Privacy Act of the Philippines) requires demonstrable per-subject consent at the point of personal data collection. Without a persisted consentGiven boolean and a server-side consentGivenAt timestamp, the platform cannot evidence consent for any test order — every collection event is non-compliant. No /privacy notice exists, so the consent presented to a client has no published controller identity, purpose statement, or data-subject-rights description to which they could meaningfully assent. CHEMICAL_TESTING and BIOLOGICAL_TESTING orders already encode the sensitive-personal-information signal via ServiceCategory, but that semantic is documented nowhere — the retention/handling implication is invisible to future engineers.

**Approach**: Persist consent on the ClientProfile model itself (consentGiven Boolean @default(false), consentGivenAt DateTime?) — one-to-one with the order so no fan-out join is needed. Promote clientDetailsSchema to the sole gate by adding consentGiven: z.literal(true), so an unchecked box is a Zod parse failure (hard submission block) rather than a soft warning bypassed at the action boundary. The action coerces the consent checkbox via the same hidden-input pattern used for the HYBRID requestCustomQuote toggle (native checkboxes are absent from FormData when unchecked); coercion is formData.get("consentGiven") === "true", then safeParse validates z.literal(true). Inside the existing $transaction, consentGiven: true + consentGivenAt: new Date() are written to tx.clientProfile.create alongside the other contact fields — no second write, no separate transaction. The privacy notice ships as a static RSC at /privacy with stub copy and a top-of-file legal-review comment; it is referenced from the consent checkbox via target=_blank. ServiceCategory CHEMICAL_TESTING/BIOLOGICAL_TESTING is documented as the sensitive-data flag in slice README and privacy page only — no new column added. redirect() in the action remains terminal (never inside try/catch) per Implementation Discipline.

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Persist consent on ClientProfile via two new columns (consentGiven Boolean @default(false), consentGivenAt DateTime?) — not a separate Consent table | RA 10173 requires demonstrable per-collection consent — a boolean flag alone fails the demonstrability test because the controller cannot prove WHEN consent was given -> consentGivenAt timestamp pairs with the boolean to satisfy the regulator -> the relationship to the collection event (the Order) is strictly one-to-one (ClientProfile.orderId is @unique) so a separate Consent table adds a join with no fan-out benefit -> two columns on ClientProfile is the minimum-surface design that captures the regulatory invariant without schema bloat |
| DL-002 | consentGiven uses z.literal(true) — not z.boolean() — in clientDetailsSchema | z.boolean() accepts both true and false; an unchecked box would parse successfully and the action would receive consentGiven: false -> the regulatory requirement is that submission MUST be blocked when consent is not given, not that the value be persisted as false -> z.literal(true) makes false a Zod parse error, surfacing as a field-level error in the form -> the consent decision is enforced at the domain boundary (single source of truth) rather than duplicated as an additional check inside the action body |
| DL-003 | Coerce the consent checkbox via a hidden input pattern (mirroring HybridToggle) — not by inspecting checkbox presence in FormData | Native HTML checkboxes are absent from FormData when unchecked — `formData.get("consentGiven")` would return null for the unchecked case and "on" for the checked case, requiring asymmetric coercion logic that diverges from the rest of the slice -> HybridToggle already established the hidden-input pattern (<input type=hidden name=requestCustomQuote value={String(state)}>) and the action coerces with `=== "true"` -> reusing the exact same pattern for consentGiven keeps the action symmetric (both booleans coerced identically) and the checkbox change does not require a full-form re-render (HybridToggle is already a client-component boundary; consent toggle can live in the main form because submission gating, not conditional rendering, is the only behaviour) |
| DL-004 | Write consentGiven: true and consentGivenAt: new Date() inside the existing $transaction (tx.clientProfile.create), not in a separate write | The Order + ClientProfile $transaction is the atomicity boundary for order creation — splitting consent writes outside breaks the atomicity invariant from the existing slice README -> consentGivenAt must be server-side (`new Date()` in the action, never a client-supplied value) to prevent timestamp spoofing -> the simplest design that satisfies both invariants is to add two literal fields to the existing tx.clientProfile.create data block; no new transaction, no upsert, no additional Prisma call |
| DL-005 | Document CHEMICAL_TESTING and BIOLOGICAL_TESTING as the sensitive-data flag — no new Order.sensitiveData column | ServiceCategory already partitions orders into the sensitive set (CHEMICAL_TESTING, BIOLOGICAL_TESTING) and the non-sensitive set (PHYSICAL_TESTING, ENVIRONMENTAL_TESTING, CALIBRATION, CERTIFICATION) -> adding Order.sensitiveData would duplicate that partition, creating a denormalization that must be kept consistent on every Order create and a migration cost with no new information -> the retention/handling implication is documented in the slice README and the /privacy page, surfacing the invariant where engineers will encounter it |
| DL-006 | Privacy notice ships as a static RSC at /privacy with stub copy and a top-of-file legal-review comment — no auth required | /privacy must be reachable from the consent checkbox before the user authenticates (clients click through during order creation but the page is also linked from marketing surfaces) — gating it behind auth would break the consent flow -> stub copy is acceptable for the PR because (a) the regulatory requirement is that a published notice exist with controller identity + purpose + rights description and (b) legal review must complete before first commercial transaction, which is a separate track from the engineering ticket -> a top-of-file comment in page.tsx makes the legal-review prerequisite explicit so the gap is visible at code-review time, not buried in a task tracker |
| DL-007 | Data-subject-rights flow (deletion, rectification, access) is documented as a manual email-to-controller process in the privacy notice — no self-service UI | RA 10173 requires the controller to honor data-subject rights but does not require the mechanism be self-service -> a self-service deletion slice has high blast-radius (cascade deletes across Order, ClientProfile, Transaction, Payout) and cannot ship without legal sign-off on retention exemptions for billing/audit records -> the NPC-compliant minimum at early MVP stage is a published contact path (email to controller) and a documented internal SOP -> the privacy notice publishes the contact path; the SOP is an admin runbook line item outside this ticket |
| DL-008 | Consent checkbox placement: after the address textarea, before the global error alert and submit button; opens /privacy in a new tab | Placement after all contact fields anchors the consent to the data the user has just entered (the user has visibly committed the data before consenting to its processing) -> placement immediately before the submit button makes the gate impossible to miss -> target=_blank on the /privacy link prevents losing the partially-filled form state when the user reads the notice |
| DL-009 | Schema migration ships locally only — prisma/migrations/ is gitignored in this repo; do not commit the migration directory | The repo .gitignore excludes prisma/migrations/ (confirmed during T-17); the convention is `npx prisma migrate dev --name <name>` applied to the local DB and `npx prisma migrate deploy` re-derives migrations against staging/production via the schema state -> committing the migration directory would diverge from the established convention and produce a noisy diff -> the PR commits only schema.prisma changes; the migration is applied locally before `npm test -- --run` so testPrisma sees the new columns |
| DL-010 | Unit test for clientDetailsSchema covers three cases: rejects consentGiven: false, rejects missing consentGiven, accepts consentGiven: true | z.literal(true) is the only Zod construct that satisfies the regulatory invariant; a future refactor mistakenly downgrading to z.boolean() would silently pass tests if only the happy path is asserted -> the false-rejection and missing-rejection cases lock the literal semantics in place -> unit-level (no DB, no action) is the right level because the schema is a pure domain primitive; integration coverage of the action+transaction write is provided implicitly by the existing slice flow and explicitly out of scope for this ticket per the playbook |
| DL-011 | Enum-drift on ServiceCategory is caught at compile time via an as const satisfies Record<ServiceCategory, boolean> sensitivity-partition constant in src/domain/orders/client-details.ts plus a unit test that asserts the partition — not by documentation alone | DL-005 says ServiceCategory CHEMICAL_TESTING/BIOLOGICAL_TESTING IS the sensitive-data flag and no Boolean column duplicates it -> if the partition lives only in README and /privacy prose, adding a new sensitive ServiceCategory (e.g. a future GENETIC_TESTING member) silently misses the privacy notice and the slice README — exactly the enum-drift gap the Compounding Protocol enum-dispatch rule was written to prevent -> the canonical project rule (Implementation Discipline bullet on enum dispatch tables) requires as const satisfies Record<EnumType, ...> so a missing entry is a compile-time error -> defining export const SENSITIVE_SERVICE_CATEGORIES = { CHEMICAL_TESTING: true, BIOLOGICAL_TESTING: true, PHYSICAL_TESTING: false, ENVIRONMENTAL_TESTING: false, CALIBRATION: false, CERTIFICATION: false } as const satisfies Record<ServiceCategory, boolean> in client-details.ts makes adding a new ServiceCategory member fail npx tsc --noEmit until the new member is explicitly classified, and the accompanying unit test (case in client-details.test.ts) asserts the exact sensitive set so an accidental flip of a partition value is caught by npm test — combining the compile-time guard and a runtime fence closes the documentation-only gap |
| DL-012 | Pre-T-20 ClientProfile rows (existing dev/seed data, consentGiven=false default, consentGivenAt=null) are an accepted out-of-scope compliance gap for this ticket — no backfill, no remediation slice — because V2 has not yet processed any commercial transaction | PipetGo V2 is greenfield: zero commercial transactions have been processed, the production database is not yet populated with real client data, and all existing ClientProfile rows are dev seeds or test fixtures that never represented real data subjects -> RA 10173 demonstrability applies to live data-subject relationships, not to dev seed rows that no real human ever assented to -> a backfill ticket that retroactively marks pre-T-20 rows as consented would itself violate the regulation by fabricating a consent event that never happened -> the correct disposition is to acknowledge pre-T-20 rows as fixture/seed data outside RA 10173 scope, document that the consent gate begins at T-20 merge for all new orders, and require the seed-data reset (or NOT NULL constraint with a forced re-seed) as a Phase-4 release prerequisite alongside legal review — this is captured here so a future auditor or engineer can see the disposition was deliberate, not an oversight |
| DL-013 | Consent revocation/withdrawal mechanics (post-creation updates to ClientProfile.consentGiven, effect on in-flight orders, prospective-only semantics under RA 10173 §34) are explicitly deferred to a future ticket T-21 — out of scope for T-20 | RA 10173 §34 grants the data subject the right to withdraw consent prospectively — distinct from the §16 right of erasure addressed in DL-007 (manual email-to-controller) -> withdrawal mechanics have non-trivial branching: an in-flight order with a placed quote and a captured payment cannot simply set consentGiven=false because the controller still has a lawful basis (contract performance under §12(b)) for the data already collected; the withdrawal applies prospectively to future processing (marketing follow-ups, re-use of contact data) -> implementing this correctly requires (a) a withdrawal endpoint or admin tool, (b) a policy decision about which downstream processing is gated on consentGiven vs gated on contract performance, (c) coordination with the lab payout/audit retention rules from T-10 -> the right scoping is a separate ticket T-21 consent withdrawal — prospective revocation to be added to docs/roadmap.md Phase 4 alongside the legal-review and NPC-registration tracks; T-20 establishes the consent capture invariant (write-once at order creation) and explicitly does NOT mutate consentGiven post-creation -> documenting this deferral here makes the regulatory gap visible at code-review time rather than buried in a backlog |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Separate Consent model (id, orderId, given Boolean, givenAt DateTime, ipAddress String?) with a FK to Order | ClientProfile is one-to-one with Order via orderId @unique — a Consent table introduces a redundant join with no fan-out (per-order consent is the unit), adds a migration footprint with no new query patterns, and forces the action to do an additional Prisma write outside or inside the $transaction. Two columns on ClientProfile capture the same invariant with less surface. (ref: DL-001) |
| z.boolean() for consentGiven with a soft warning if false | z.boolean() accepts false; the regulatory invariant is that submission be blocked when consent is not given. A soft warning would let an action persist consentGiven: false to ClientProfile, producing a record where the controller cannot demonstrate consent was given — the opposite of the RA 10173 requirement. z.literal(true) is the only Zod shape that means consent was given. (ref: DL-002) |
| Native checkbox in the main form with action-side coercion via formData.get("consentGiven") === "on" | The HybridToggle pattern already standardized hidden-input + === "true" coercion for the slice. Diverging would create two coercion patterns in the same action body — asymmetric to the existing requestCustomQuote handling — and require remembering that native checkboxes use "on" not "true". The hidden-input pattern reads the boolean reliably regardless of checkbox state and unifies the coercion. (ref: DL-003) |
| New Order.sensitiveData Boolean column populated at create time from ServiceCategory | ServiceCategory already encodes the partition; a Boolean column duplicates that information and must be kept consistent on every Order create. It adds migration cost with no new query primitive (every consumer can branch on category directly). Documentation in slice README + /privacy is the lower-cost, lower-risk path. (ref: DL-005) |
| Self-service deletion UI on the client dashboard | RA 10173 honors data-subject rights but does not require the mechanism be self-service. A self-service deletion has high blast radius (cascade across Order, ClientProfile, Transaction, Payout) and cannot ship without legal sign-off on retention exemptions for billing/audit records. The NPC-compliant minimum is a published contact path; manual email is acceptable at early MVP. Deferred to a future ticket once retention policy is legally reviewed. (ref: DL-007) |
| Commit prisma/migrations/ to the PR alongside schema.prisma | prisma/migrations/ is gitignored in this repo by established convention (T-16, T-17 followed the same pattern). Committing would diverge from convention, produce a noisy diff, and require coordinating local migration filenames across contributors. The schema.prisma diff is the source of truth; migrate dev is re-runnable from schema state. (ref: DL-009) |

### Constraints

- consentGiven and consentGivenAt are written inside the existing $transaction (tx.clientProfile.create) — never in a separate Prisma call
- consentGiven is validated as z.literal(true) in clientDetailsSchema — z.boolean() is forbidden
- clientDetailsSchema remains the sole validator at the action boundary — no second Zod schema introduced in the action or UI
- redirect() in action.ts is the terminal statement — never inside any try/catch (Implementation Discipline)
- consentGivenAt is server-side (new Date() in the action) — never a client-supplied value
- prisma/migrations/ is gitignored — migration applied locally, not committed
- /privacy is a static RSC, no auth required; legal-review note appears as a top-of-file comment
- No new column on Order for sensitive-data — ServiceCategory CHEMICAL_TESTING/BIOLOGICAL_TESTING IS the flag; documented in slice README + /privacy

### Known Risks

- **Privacy notice stub copy ships to production without legal review, exposing the platform to NPC enforcement risk on first commercial transaction**: Top-of-file comment in src/app/privacy/page.tsx flags legal review as a release blocker; roadmap.md Phase-4 prerequisites already list Privacy notice legal review and NPC registration as separate non-engineering tracks. PR description repeats the prerequisite. The engineering scope is complete when the consent gate works mechanically; commercial release is gated on the legal track.
- **Testing forgets to apply the migration locally — testPrisma fails on the new columns with an obscure Prisma error**: Plan execution order places the schema migration first; the playbook step 7 explicitly requires npx prisma migrate dev --name add-client-profile-consent before npm test -- --run. The unit test for clientDetailsSchema does not touch the DB, so the schema validation gate runs even without the migration — only an integration-style test would surface a missing migration. (No DB-backed test is in scope for this ticket.)
- **A future contributor downgrades clientDetailsSchema consentGiven to z.boolean() during a refactor and silently breaks the regulatory invariant**: Unit test in src/domain/orders/__tests__/client-details.test.ts asserts three cases: consentGiven=false rejected, missing rejected, consentGiven=true accepted. z.boolean() would pass the third but fail the first two, so the test fence makes the downgrade impossible to ship green.
- **Form submission without checking consent leaves the address textarea populated but the submit button click does nothing (the action returns errors) — without a field-level error message the user does not know why submission failed**: ui.tsx renders state?.errors?.consentGiven[0] as a red text-sm error inline below the checkbox label, matching the existing error-display pattern on name/email/phone. Zod field path for z.literal(true) failure surfaces as errors.consentGiven; the same flatten().fieldErrors path used by every other field.

## Invisible Knowledge

### System

RA 10173 (Data Privacy Act of the Philippines) requires the data controller to demonstrate that consent was given by the data subject at the point of personal-data collection — a boolean flag alone is insufficient without a timestamp. The platform satisfies this by persisting consentGiven Boolean + consentGivenAt DateTime? on the ClientProfile model, written server-side inside the same $transaction as Order.create. The Zod z.literal(true) shape on consentGiven is the domain-boundary gate that hard-blocks submission when the consent checkbox is unchecked — z.boolean() would silently accept the unchecked case. The consent checkbox uses the hidden-input pattern (matching HybridToggle.tsx) because native HTML checkboxes are absent from FormData when unchecked; the action coerces with === "true" and feeds the boolean into safeParse. Sensitive personal information under NPC guidelines is identified at the schema level by ServiceCategory ∈ {CHEMICAL_TESTING, BIOLOGICAL_TESTING} — no Boolean column duplicates that partition because adding one would create a denormalization that must be kept consistent on every Order create. The /privacy page is a static RSC publicly accessible without auth; its top-of-file comment marks legal-review-before-commercial-release as a release prerequisite separate from this engineering ticket. Data-subject rights (access, rectification, erasure) are honored via a manual email-to-controller process documented on the privacy page; a self-service deletion UI is deferred until retention exemptions for billing/audit records have been legally reviewed.

### Invariants

- consentGiven Boolean @default(false) and consentGivenAt DateTime? are the only two new columns on ClientProfile for RA 10173 — no other model touched
- consentGiven in clientDetailsSchema is z.literal(true) — submission is blocked at the domain boundary when consent is not given; the false case never reaches the action body
- consentGivenAt is written server-side as new Date() inside the existing $transaction — client-supplied values are never trusted
- Sensitive personal information under NPC guidelines is identified by ServiceCategory ∈ {CHEMICAL_TESTING, BIOLOGICAL_TESTING} — no Boolean column duplicates this partition
- /privacy is publicly accessible (no auth middleware), static (RSC), and legally reviewed before any commercial transaction
- Consent checkbox uses the hidden-input pattern (mirroring HybridToggle) — action coerces with === "true" so both booleans in the slice (requestCustomQuote, consentGiven) follow the same coercion path

### Tradeoffs

- Stub privacy copy ships green with a code-comment legal-review marker vs blocking the PR on legal copy — the engineering gate (mechanical consent capture) is independently testable and merges; legal copy is a parallel track with a different cycle time. The risk is documented in known_risks and the marker is visible at code-review.
- Two columns on ClientProfile vs a Consent table — saves a join and a migration footprint; the table loses a separable retention/audit primitive that a per-event consent log would have. At MVP scale with one-to-one orderId, the audit value is negligible; if a future ticket needs versioned consent history (terms changes, re-consent), a Consent table is the natural extension and the ClientProfile columns become the latest-state snapshot.
- Hidden-input pattern for the consent checkbox vs direct FormData coercion — the hidden-input pattern is one additional input element per checkbox but unifies the coercion path with HybridToggle and removes the asymmetry between === "true" and === "on". Cost is one input element; benefit is one less invariant to remember when adding the next checkbox to the form.
- Document sensitive categories in README + /privacy vs a Boolean column on Order — the column is queryable and indexable; the documentation is not. At current scale no query needs an index on sensitivity; ServiceCategory itself is queryable. If a retention-sweep job lands later that needs a fast scan of sensitive orders, an index on ServiceCategory is the additive change; introducing the Boolean now is premature.

## Milestones

### Milestone 1: RA 10173 consent capture: schema + domain + slice + privacy page + test

**Files**: prisma/schema.prisma, src/domain/orders/client-details.ts, src/features/orders/create-order/action.ts, src/features/orders/create-order/ui.tsx, src/features/orders/create-order/README.md, src/app/privacy/page.tsx, src/domain/orders/__tests__/client-details.test.ts

**Flags**: schema-migration, domain-validation, compliance

**Requirements**:

- ClientProfile model has consentGiven Boolean @default(false) and consentGivenAt DateTime? columns | clientDetailsSchema rejects consentGiven absent or false (z.literal(true)) and accepts consentGiven true | create-order action coerces consentGiven from a hidden input via === "true" and writes consentGiven true + consentGivenAt new Date() to tx.clientProfile.create inside the existing $transaction | redirect remains the terminal statement in action.ts (outside any try/catch) | ui.tsx renders a consent checkbox after the address textarea
- with a hidden input for FormData coercion
- a target=_blank link to /privacy
- and inline field-level error display for state.errors.consentGiven | /privacy page exists as a static RSC with stub copy and a top-of-file legal-review comment | slice README documents that CHEMICAL_TESTING and BIOLOGICAL_TESTING ServiceCategory values are the sensitive-personal-information flag under NPC guidelines | unit test asserts clientDetailsSchema rejects consentGiven=false
- rejects missing consentGiven
- accepts consentGiven=true

**Acceptance Criteria**:

- AC-001: prisma/schema.prisma defines ClientProfile.consentGiven Boolean @default(false) and ClientProfile.consentGivenAt DateTime?; npx prisma generate succeeds; npx prisma migrate dev --name add-client-profile-consent applied locally creates two new columns on client_profiles | AC-002: clientDetailsSchema.safeParse rejects {consentGiven: false ...valid contact fields} with a field-level error on consentGiven; rejects an object missing consentGiven; accepts {consentGiven: true ...valid contact fields} | AC-003: ClientDetails type exported from src/domain/orders/client-details.ts includes consentGiven of type true (the literal); npx tsc --noEmit clean | AC-004: Submitting the create-order form with the checkbox unchecked sets state.errors.consentGiven and does not call prisma — verified by manual flow inspection or implicitly by AC-002 since the action defers to safeParse | AC-005: Submitting the form with the checkbox checked writes ClientProfile with consentGiven=true and a non-null consentGivenAt; the timestamp is server-side (new Date in the action) and lies inside the same $transaction as the Order.create (single Prisma round-trip from the slice perspective) | AC-006: ui.tsx renders a checkbox labeled with a privacy-notice phrase and a target=_blank link to /privacy positioned after the address textarea and before the submit button; state.errors.consentGiven renders inline | AC-007: src/app/privacy/page.tsx returns a static RSC body covering data-controller identity
- purpose
- categories of data
- retention period
- NPC contact
- and data-subject rights with a top-of-file legal-review comment; the page is publicly accessible (no auth gate) | AC-008: src/features/orders/create-order/README.md documents that CHEMICAL_TESTING and BIOLOGICAL_TESTING are the sensitive-personal-information flag under NPC guidelines and that no Boolean column duplicates this partition | AC-009: npx tsc --noEmit clean
- npx eslint src/ clean
- npm test -- --run all green | AC-010: prisma/migrations/ directory remains gitignored — the PR commit includes schema.prisma but no migration files

**Tests**:

- unit

#### Code Intent

- **CI-M-001-001** `prisma/schema.prisma`: Add two columns to the ClientProfile model immediately after the address String? line and before the createdAt line: consentGiven Boolean @default(false) and consentGivenAt DateTime?. Default false ensures the column is non-null for existing rows; the timestamp is nullable because pre-T-20 ClientProfile rows have no recorded consent event. Add a two-line comment above the two fields: (line 1) RA 10173 consent (Data Privacy Act of the Philippines) — consentGiven validated as z.literal(true) at the action boundary; consentGivenAt is server-side new Date() inside the create-order $transaction; (line 2) Pre-T-20 rows are dev/seed fixtures only — V2 has processed zero commercial transactions; seed-data reset is a Phase-4 release prerequisite per DL-012, not a backfill ticket. No other model touched. No new index — there is no query path keyed on consentGiven. (refs: DL-001, DL-004, DL-012)
- **CI-M-001-002** `src/domain/orders/client-details.ts::clientDetailsSchema`: Append a consentGiven field at the end of the clientDetailsSchema z.object, defined as z.literal(true) with a custom error message (errorMap returns Privacy consent is required for the data controller to lawfully process your order under RA 10173). The literal(true) shape causes both missing and false values to fail safeParse, surfacing as parsed.error.flatten().fieldErrors.consentGiven. The ClientDetails type exported from z.infer<typeof clientDetailsSchema> automatically gains consentGiven: true. Module JSDoc remains in place; add one sentence noting consentGiven encodes RA 10173 consent and must remain z.literal(true) per Implementation Discipline. Additionally export a SENSITIVE_SERVICE_CATEGORIES constant typed as const satisfies Record<ServiceCategory, boolean> with all six members explicitly enumerated: CHEMICAL_TESTING: true, BIOLOGICAL_TESTING: true, PHYSICAL_TESTING: false, ENVIRONMENTAL_TESTING: false, CALIBRATION: false, CERTIFICATION: false. Import ServiceCategory from @prisma/client. The constant gains a top-of-block comment noting: Adding a new ServiceCategory member triggers a TypeScript compile error here until the new member is classified — preventing silent enum-drift that would miss /privacy notice and slice README updates (DL-011). Also export a derived helper export function isSensitiveServiceCategory(category: ServiceCategory): boolean { return SENSITIVE_SERVICE_CATEGORIES[category] } so consumers branch on the dispatch map rather than re-encoding the partition in each call site. (refs: DL-002, DL-005, DL-011)
- **CI-M-001-003** `src/features/orders/create-order/action.ts::createOrder`: In the rawDetails object built from formData, add a consentGiven field coerced as formData.get("consentGiven") === "true" — mirroring the requestCustomQuote pattern. The rawDetails object now includes consentGiven of type boolean (not optional). The existing clientDetailsSchema.safeParse(rawDetails) call validates the field — when the checkbox was unchecked the value is false and Zod rejects with parsed.error.flatten().fieldErrors.consentGiven; return that errors object as the action state (existing return shape). Inside the existing prisma.$transaction async (tx) block, in the tx.clientProfile.create data argument, add two new fields below address: consentGiven: true (literal true, since safeParse has already proven it) and consentGivenAt: new Date() (server-side timestamp). No new transaction, no upsert, no additional Prisma call. The redirect calls at the end of createOrder remain outside any try/catch and remain the terminal statements in their branches per Implementation Discipline. (refs: DL-003, DL-004)
- **CI-M-001-004** `src/features/orders/create-order/ui.tsx::OrderFormShell`: Add a consent checkbox block inside the form, positioned after the address textarea div and before the global error Alert div. The block is a div with class space-y-2 containing: (1) a hidden input <input type=hidden name=consentGiven value={String(consentGiven)}> where consentGiven is a local useState<boolean>(false); (2) a flex container with a native <input type=checkbox id=consentGiven checked={consentGiven} onChange={(e) => setConsentGiven(e.target.checked)} className=mt-1>; (3) a label htmlFor=consentGiven className=text-sm cursor-pointer that reads: I consent to PipetGo processing my personal data for the purposes described in the Privacy Notice (link to /privacy with target=_blank rel=noopener referrer); (4) below the label, conditionally render state?.errors?.consentGiven && <p className=text-sm text-red-600 mt-1>{state.errors.consentGiven[0]}</p>. Import useState locally; no new client-component boundary needed (HybridToggle remains isolated because it conditionally renders Alert; the consent checkbox only gates submission and has no conditional render that would force a wider boundary). Do not change other fields, the existing submit button, or the layout of the rest of the form. (refs: DL-003, DL-008)
- **CI-M-001-005** `src/features/orders/create-order/README.md`: Append a new section RA 10173 Privacy Compliance under Invariants. Five bullets: (1) consentGiven persisted to ClientProfile alongside consentGivenAt new Date() — server-side timestamp, inside the existing $transaction, never client-supplied; consent record is per-order (one ClientProfile per Order); (2) clientDetailsSchema.consentGiven is z.literal(true) — submission is hard-blocked at the domain boundary when the checkbox is unchecked, not soft-warned; downgrading to z.boolean() silently breaks the regulatory invariant and is caught by unit tests in client-details.test.ts; (3) Sensitive personal information under NPC guidelines is identified by ServiceCategory in {CHEMICAL_TESTING, BIOLOGICAL_TESTING}; no Boolean column on Order duplicates this partition; enum-drift on ServiceCategory is caught at compile time by the SENSITIVE_SERVICE_CATEGORIES as const satisfies Record<ServiceCategory, boolean> dispatch map in src/domain/orders/client-details.ts (DL-011) — adding a new ServiceCategory member fails npx tsc --noEmit until classified; (4) Pre-T-20 ClientProfile rows (consentGiven=false, consentGivenAt=null) are dev/seed fixtures only and are explicitly out of scope for this ticket per DL-012; the consent gate begins at T-20 merge for all new orders; seed-data reset is a Phase-4 release prerequisite, not a backfill ticket — fabricating retroactive consent would itself violate RA 10173; (5) Consent revocation/withdrawal mechanics (prospective revocation under RA 10173 §34) are deferred to a future ticket T-21 per DL-013; T-20 establishes write-once consent at order creation and does not mutate consentGiven post-creation; in-flight orders retain a lawful basis under §12(b) contract performance even if a future withdrawal endpoint sets consentGiven=false prospectively. Architecture diagram and the existing invariants list are unchanged. (refs: DL-005, DL-011, DL-012, DL-013)
- **CI-M-001-006** `src/app/privacy/page.tsx`: New static React Server Component (no use client directive, no auth gate). Top-of-file comment: LEGAL REVIEW REQUIRED before first commercial transaction — stub copy below is engineering-level only; controller identity, retention periods, NPC complaint procedure, and data-subject rights wording must be reviewed by counsel and approved by the Data Protection Officer per NPC Circular 16-01. Filed alongside NPC registration; see docs/roadmap.md Phase 4 prerequisites. Page exports default async function PrivacyPage returning a max-w-3xl mx-auto px-4 py-8 prose container with: (1) h1 Privacy Notice; (2) section Data Controller naming PipetGo and a placeholder contact email privacy@pipetgo.example; (3) section Purpose of Collection covering: facilitating laboratory test orders, coordinating sample logistics with accredited labs, processing payments, and producing test reports; (4) section Categories of Data Collected covering: contact details (name, email, phone, organization, address), order details (service, sample description, special instructions), and — for orders in ServiceCategory CHEMICAL_TESTING or BIOLOGICAL_TESTING — sensitive personal information about chemical or biological samples submitted for analysis under NPC guidelines; (5) section Retention with placeholder text noting records retained for the statutory period required for tax and audit (BIR retention guidance), with sensitive-category test results subject to additional handling per accredited-lab SOPs; (6) section Data Subject Rights enumerating access, rectification, erasure, objection, data portability, and complaint to the NPC, with a contact link emailed to the privacy email above; (7) section NPC Contact naming the National Privacy Commission with website https://privacy.gov.ph as the regulator. No images, no client components, no third-party dependencies. The route at /privacy is publicly accessible by virtue of being inside src/app/privacy/page.tsx with no layout-level auth gate (root layout has no auth guard). (refs: DL-006, DL-007)
- **CI-M-001-007** `src/domain/orders/__tests__/client-details.test.ts`: New unit test file (no DB, no Prisma). Imports clientDetailsSchema, SENSITIVE_SERVICE_CATEGORIES, and isSensitiveServiceCategory from ../client-details and ServiceCategory from @prisma/client. Two outer describe blocks. First: describe("clientDetailsSchema — RA 10173 consent", ...) with three cases: (1) it("rejects when consentGiven is false", () => safeParse with a fully valid contact object plus consentGiven: false; assert success === false and error.flatten().fieldErrors.consentGiven is defined); (2) it("rejects when consentGiven is missing", () => safeParse with a fully valid contact object omitting consentGiven; assert success === false and error.flatten().fieldErrors.consentGiven is defined); (3) it("accepts when consentGiven is true", () => safeParse with a fully valid contact object plus consentGiven: true; assert success === true and data.consentGiven === true). The valid contact object used in all three cases: {name: "Test Client", email: "test@example.com", phone: "+639171234567"} (organization and address are optional). Second: describe("SENSITIVE_SERVICE_CATEGORIES — enum-drift fence (DL-011)", ...) with two cases: (a) it("classifies CHEMICAL_TESTING and BIOLOGICAL_TESTING as sensitive and the remaining four categories as non-sensitive", () => assert SENSITIVE_SERVICE_CATEGORIES.CHEMICAL_TESTING === true, SENSITIVE_SERVICE_CATEGORIES.BIOLOGICAL_TESTING === true, SENSITIVE_SERVICE_CATEGORIES.PHYSICAL_TESTING === false, SENSITIVE_SERVICE_CATEGORIES.ENVIRONMENTAL_TESTING === false, SENSITIVE_SERVICE_CATEGORIES.CALIBRATION === false, SENSITIVE_SERVICE_CATEGORIES.CERTIFICATION === false); (b) it("covers every ServiceCategory enum member (compile-time satisfies guard + runtime length fence)", () => assert Object.keys(SENSITIVE_SERVICE_CATEGORIES).sort() deep-equals Object.values(ServiceCategory).sort() — so even though the satisfies clause already enforces coverage at compile time, a runtime regression from accidental cast-to-Record<string, ...> still fails this test). No other test cases are added (existing field validations are pre-existing and out of scope here). (refs: DL-010, DL-011)

#### Code Changes

**CC-M-001-001** (prisma/schema.prisma) - implements CI-M-001-001

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -212,5 +212,9 @@ model ClientProfile {
   organization String?
   address      String?
+  // RA 10173 consent (Data Privacy Act of the Philippines) — consentGiven validated as z.literal(true) at the action boundary; consentGivenAt is server-side new Date() inside the create-order $transaction
+  // Pre-T-20 rows are dev/seed fixtures only — V2 has processed zero commercial transactions; seed-data reset is a Phase-4 release prerequisite per DL-012, not a backfill ticket
+  consentGiven Boolean @default(false)
+  consentGivenAt DateTime?
   createdAt    DateTime @default(now())
 
   order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)
```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -204,4 +204,6 @@ model Payout {
 // Snapshot of client contact data at order time; one-to-one with Order, not
-// reusable across orders. Contact data shape is DB-enforced via ClientProfile. (ref: DL-002)
+// reusable across orders. Contact data shape is DB-enforced via ClientProfile. (ref: DL-002)
+// consentGiven + consentGivenAt satisfy RA 10173 demonstrability — a boolean alone fails the
+// regulator's standard; the timestamp proves WHEN consent was recorded. (ref: DL-001)
+// Migration: prisma/migrations/ is gitignored — apply locally with `npx prisma migrate dev`;
+// the PR commits only schema.prisma. (ref: DL-009)
 model ClientProfile {

```


**CC-M-001-002** (src/domain/orders/client-details.ts) - implements CI-M-001-002

**Code:**

```diff
--- a/src/domain/orders/client-details.ts
+++ b/src/domain/orders/client-details.ts
@@ -1,8 +1,12 @@ /**
 /**
  * Zod validation schema for client contact data captured at order creation.
  *
  * Coexists with the ClientProfile Prisma model: this schema validates at the
  * Server Action boundary; the Prisma model persists the normalized record.
  * Shape is enforced at both input validation and DB persistence layers. (ref: DL-002)
+  *
+  * consentGiven encodes RA 10173 explicit consent and must remain z.literal(true) per
+  * Implementation Discipline — downgrading to z.boolean() silently breaks the regulatory invariant.
  */
 import { z } from "zod";
+import { ServiceCategory } from "@prisma/client";
@@ -17,5 +20,24 @@ export const clientDetailsSchema = z.object({
   organization: z.string().max(200).optional(),
   address: z.string().max(500).optional(),
+  consentGiven: z.literal(true, {
+    errorMap: () => ({ message: "Privacy consent is required for the data controller to lawfully process your order under RA 10173." }),
+  }),
 });
 
 export type ClientDetails = z.infer<typeof clientDetailsSchema>;
+
+// Adding a new ServiceCategory member triggers a TypeScript compile error here until
+// the new member is classified — preventing silent enum-drift that would miss /privacy
+// notice and slice README updates (DL-011)
+export const SENSITIVE_SERVICE_CATEGORIES = {
+  CHEMICAL_TESTING: true,
+  BIOLOGICAL_TESTING: true,
+  PHYSICAL_TESTING: false,
+  ENVIRONMENTAL_TESTING: false,
+  CALIBRATION: false,
+  CERTIFICATION: false,
+} as const satisfies Record<ServiceCategory, boolean>;
+
+export function isSensitiveServiceCategory(category: ServiceCategory): boolean {
+  return SENSITIVE_SERVICE_CATEGORIES[category];
+}
```

**Documentation:**

```diff
--- a/src/domain/orders/client-details.ts
+++ b/src/domain/orders/client-details.ts
@@ -1,7 +1,10 @@
 /**
  * Zod validation schema for client contact data captured at order creation.
  *
  * Coexists with the ClientProfile Prisma model: this schema validates at the
  * Server Action boundary; the Prisma model persists the normalized record.
- * Shape is enforced at both input validation and DB persistence layers. (ref: DL-002)
+ * Shape is enforced at both input validation and DB persistence layers. (ref: DL-002)
+ *
+ * consentGiven must remain z.literal(true) — not z.boolean() — so an unchecked box
+ * fails safeParse at the domain boundary and blocks submission without a second guard
+ * in the action. Downgrading to z.boolean() silently breaks the RA 10173 invariant.
  */
@@ -20,6 +23,7 @@ export const clientDetailsSchema = z.object({
   organization: z.string().max(200).optional(),
   address: z.string().max(500).optional(),
+  // z.literal(true): false or absent both fail safeParse, surfacing as a field-level error. (ref: DL-002)
   consentGiven: z.literal(true, {
     errorMap: () => ({ message: "Privacy consent is required for the data controller to lawfully process your order under RA 10173." }),
   }),
@@ -27,6 +31,11 @@ export const clientDetailsSchema = z.object({
 export type ClientDetails = z.infer<typeof clientDetailsSchema>;

+// Compile-time enum-drift fence: adding a new ServiceCategory member triggers a TypeScript
+// error here until it is classified. Prevents silent omission from /privacy and slice README. (ref: DL-011)
 export const SENSITIVE_SERVICE_CATEGORIES = {
   CHEMICAL_TESTING: true,
   BIOLOGICAL_TESTING: true,
@@ -37,5 +46,10 @@ export const SENSITIVE_SERVICE_CATEGORIES = {
   CERTIFICATION: false,
 } as const satisfies Record<ServiceCategory, boolean>;

+/**
+ * Returns true when the ServiceCategory involves data classified as sensitive personal
+ * information under NPC guidelines (chemical and biological testing samples).
+ * SENSITIVE_SERVICE_CATEGORIES is the single source of truth; this function is the
+ * public API over that record. (ref: DL-005, DL-011)
+ */
 export function isSensitiveServiceCategory(category: ServiceCategory): boolean {
   return SENSITIVE_SERVICE_CATEGORIES[category];
 }

```


**CC-M-001-003** (src/features/orders/create-order/action.ts) - implements CI-M-001-003

**Code:**

```diff
--- a/src/features/orders/create-order/action.ts
+++ b/src/features/orders/create-order/action.ts
@@ -34,7 +34,8 @@ export async function createOrder(
   const rawDetails = {
     name: formData.get("name"),
     email: formData.get("email"),
     phone: formData.get("phone"),
     organization: formData.get("organization") || undefined,
     address: formData.get("address") || undefined,
+    consentGiven: formData.get("consentGiven") === "true" ? true : undefined,
   }
@@ -80,9 +81,11 @@ export async function createOrder(
       data: {
         orderId: created.id,
         name: parsed.data.name,
         email: parsed.data.email,
         phone: parsed.data.phone,
         organization: parsed.data.organization,
         address: parsed.data.address,
+        consentGiven: true,
+        consentGivenAt: new Date(),
       },
     })

```

**Documentation:**

```diff
--- a/src/features/orders/create-order/action.ts
+++ b/src/features/orders/create-order/action.ts
@@ -34,6 +34,8 @@ export async function createOrder(
   const rawDetails = {
     name: formData.get('name'),
     email: formData.get('email'),
     phone: formData.get('phone'),
     organization: formData.get('organization') || undefined,
     address: formData.get('address') || undefined,
+    // Native checkbox is absent from FormData when unchecked; hidden-input pattern (DL-003) ensures
+    // 'true' or 'false' is always present. clientDetailsSchema requires z.literal(true), so 'false'
+    // coerces to undefined and safeParse fails — blocking submission without a second guard.
+    consentGiven: formData.get('consentGiven') === 'true' ? true : undefined,
   }
@@ -80,9 +84,11 @@ export async function createOrder(
       data: {
         orderId: created.id,
         name: parsed.data.name,
         email: parsed.data.email,
         phone: parsed.data.phone,
         organization: parsed.data.organization,
         address: parsed.data.address,
+        // Consent fields written inside the $transaction to preserve Order+ClientProfile atomicity
+        // (DL-004). consentGivenAt is server-side to prevent client timestamp spoofing.
+        consentGiven: true,
+        consentGivenAt: new Date(),
       },
     })

```


**CC-M-001-004** (src/features/orders/create-order/ui.tsx) - implements CI-M-001-004

**Code:**

```diff
--- a/src/features/orders/create-order/ui.tsx
+++ b/src/features/orders/create-order/ui.tsx
@@ -16,4 +16,5 @@ export function OrderFormShell({ service, userEmail }: OrderFormShellProps) {
   const [state, formAction, isPending] = useActionState(createOrder, null)
   const [isCustomQuote, setIsCustomQuote] = useState(false)
+  const [consentGiven, setConsentGiven] = useState(false)
 
   const submitLabel = isPending
@@ -254,4 +255,28 @@ export function OrderFormShell({ service, userEmail }: OrderFormShellProps) {
                 />
               </div>
 
+              {/* RA 10173 Consent */}
+              <div className="flex items-start gap-3 rounded-md border border-gray-200 p-3">
+                <input type="hidden" name="consentGiven" value={String(consentGiven)} />
+                <input
+                  id="consentGiven"
+                  type="checkbox"
+                  checked={consentGiven}
+                  onChange={(e) => setConsentGiven(e.target.checked)}
+                  className="mt-0.5 h-4 w-4 shrink-0"
+                />
+                <label htmlFor="consentGiven" className="text-sm text-gray-700">
+                  I consent to PipetGo collecting and processing my personal information
+                  (name, email, phone, organization, and address) to fulfil this testing
+                  request, as described in our{" "}
+                  <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline text-green-700">
+                    Privacy Notice
+                  </a>
+                  . This consent is required under RA 10173 (Data Privacy Act of the Philippines).
+                </label>
+              </div>
+              {state?.errors?.consentGiven && (
+                <p className="text-sm text-red-600 mt-1">{state.errors.consentGiven[0]}</p>
+              )}
+
               {/* Global error message */}

```

**Documentation:**

```diff
--- a/src/features/orders/create-order/ui.tsx
+++ b/src/features/orders/create-order/ui.tsx
@@ -255,4 +255,28 @@ export function OrderFormShell({ service, userEmail }: OrderFormShellProps) {
               </div>
 
+              {/* RA 10173 Consent
+                  Hidden input mirrors HybridToggle pattern (DL-003): native checkboxes are absent
+                  from FormData when unchecked, so the hidden input ensures 'true' or 'false' is
+                  always present. The checkbox updates consentGiven state; the action reads the hidden
+                  input only. target=_blank on /privacy prevents losing partially-filled form (DL-008). */}
+              <div className="flex items-start gap-3 rounded-md border border-gray-200 p-3">
+                <input type="hidden" name="consentGiven" value={String(consentGiven)} />

```


**CC-M-001-005** (src/features/orders/create-order/README.md) - implements CI-M-001-005

**Code:**

```diff
--- a/src/features/orders/create-order/README.md
+++ b/src/features/orders/create-order/README.md
@@ -50,1 +50,13 @@ create-order
 - `ClientProfile` is created (not upserted); one `ClientProfile` per `Order` enforced by `orderId @unique` in schema.
+
+## RA 10173 Privacy Compliance
+
+**Sensitive-data flag**: `ServiceCategory.CHEMICAL_TESTING` and `ServiceCategory.BIOLOGICAL_TESTING` are classified as sensitive personal information categories under NPC guidelines. No dedicated column is added to `Order`; the `service.category` field on the related `LabService` is the flag. Querying sensitive orders: `where: { service: { category: { in: ['CHEMICAL_TESTING', 'BIOLOGICAL_TESTING'] } } }`.
+
+**Consent record**: `ClientProfile.consentGiven` (`Boolean @default(false)`) and `ClientProfile.consentGivenAt` (`DateTime?`) are written inside the existing `$transaction` alongside `Order` and `ClientProfile`. The timestamp is server-side (`new Date()` in the action) to prevent client-supplied spoofing.
+
+**Checkbox to FormData coercion**: Native HTML checkboxes send `'on'` when checked and are absent from `FormData` when unchecked. The consent checkbox uses a hidden input pattern (matching `HybridToggle`): `<input type="hidden" name="consentGiven" value={String(consentGiven)}>` ensures `FormData` always contains `'true'` or `'false'`. The action coerces `formData.get('consentGiven') === 'true'` to `true | undefined`; `clientDetailsSchema` uses `z.literal(true)`, so an unchecked box (`undefined`) fails `safeParse` and the submission is blocked.
+
+**Privacy page**: Static RSC at `/privacy` (no auth required). Legal review is a prerequisite before the first commercial transaction; stub copy is acceptable for the PR.
+
+**Self-service deletion**: Deferred to post-MVP. Clients may request data deletion via email; the request process is documented on the `/privacy` page.
```

**Documentation:**

```diff
--- a/src/features/orders/create-order/README.md
+++ b/src/features/orders/create-order/README.md
@@ -50,1 +50,2 @@ create-order
 - `ClientProfile` is created (not upserted); one `ClientProfile` per `Order` enforced by `orderId @unique` in schema.
+- `ClientProfile.consentGiven` and `ClientProfile.consentGivenAt` are written inside the existing `$transaction` — never in a separate Prisma call — to preserve Order+ClientProfile atomicity. (ref: DL-004)
+- `ServiceCategory.CHEMICAL_TESTING` and `ServiceCategory.BIOLOGICAL_TESTING` are the sensitive-personal-information flag under NPC guidelines; no Boolean column on `Order` duplicates this partition. (ref: DL-005)
+- `ClientProfile` rows with consentGiven=false, consentGivenAt=null are dev/seed fixtures outside RA 10173 scope; seed data must be reset before production use. (ref: DL-012)
+- Consent revocation/withdrawal mechanics are not implemented; consentGiven is write-once at order creation and is never mutated post-creation. (ref: DL-013)
+- `prisma/migrations/` is gitignored — migration applied locally only; the PR commits only `schema.prisma` changes. (ref: DL-009)

```


**CC-M-001-006** (src/app/privacy/page.tsx) - implements CI-M-001-006

**Code:**

```diff
--- /dev/null
+++ b/src/app/privacy/page.tsx
@@ -0,0 +1,118 @@
+// LEGAL REVIEW REQUIRED before first commercial transaction — stub copy below is
+// engineering-level only; controller identity, retention periods, NPC complaint procedure,
+// and data-subject rights wording must be reviewed by counsel and approved by the Data
+// Protection Officer per NPC Circular 16-01. Filed alongside NPC registration;
+// see docs/roadmap.md Phase 4 prerequisites.
+import type { Metadata } from 'next'
+
+export const metadata: Metadata = {
+  title: 'Privacy Notice — PipetGo',
+  description: 'How PipetGo collects, uses, and protects your personal information under RA 10173.',
+}
+
+export default function PrivacyPage() {
+  return (
+    <main className="max-w-3xl mx-auto px-4 py-12 text-gray-800">
+      <h1 className="text-3xl font-bold mb-2">Privacy Notice</h1>
+      <p className="text-sm text-gray-500 mb-8">Last updated: May 2026</p>
+
+      <section className="mb-8">
+        <h2 className="text-xl font-semibold mb-2">1. Who We Are</h2>
+        <p>
+          PipetGo is a laboratory testing marketplace operated in the Philippines. We act as the
+          personal information controller for data collected through this platform. Our contact
+          address for privacy matters is{' '}
+          <a href="mailto:privacy@pipetgo.com" className="underline text-green-700">
+            privacy@pipetgo.com
+          </a>
+          .
+        </p>
+      </section>
+
+      <section className="mb-8">
+        <h2 className="text-xl font-semibold mb-2">2. What We Collect</h2>
+        <p className="mb-2">
+          When you submit a test request, we collect the following personal information:
+        </p>
+        <ul className="list-disc pl-6 space-y-1">
+          <li>Full name</li>
+          <li>Email address</li>
+          <li>Phone number</li>
+          <li>Organization or institution name (optional)</li>
+          <li>Shipping address (optional)</li>
+        </ul>
+        <p className="mt-2">
+          Certain service categories — specifically chemical testing and biological testing — may
+          involve samples that constitute sensitive personal information under National Privacy
+          Commission (NPC) guidelines. We handle these with additional care.
+        </p>
+      </section>
+
+      <section className="mb-8">
+        <h2 className="text-xl font-semibold mb-2">3. Why We Collect It</h2>
+        <p>
+          We collect your personal information to fulfil your testing request: to communicate
+          with you about your order, to coordinate sample delivery with the laboratory, and to
+          issue receipts and invoices. We do not sell your personal information to third parties.
+        </p>
+      </section>
+
+      <section className="mb-8">
+        <h2 className="text-xl font-semibold mb-2">4. Legal Basis</h2>
+        <p>
+          We process your personal information on the basis of your explicit consent, given at
+          the time you submit a test request. This consent is recorded with a timestamp as
+          required by Republic Act No. 10173 (Data Privacy Act of the Philippines).
+        </p>
+      </section>
+
+      <section className="mb-8">
+        <h2 className="text-xl font-semibold mb-2">5. How Long We Keep It</h2>
+        <p>
+          We retain your personal information for as long as necessary to fulfil the purposes
+          described in this notice and to comply with legal obligations. Order records are
+          typically retained for five years from the date of the transaction.
+        </p>
+      </section>
+
+      <section className="mb-8">
+        <h2 className="text-xl font-semibold mb-2">6. Your Rights</h2>
+        <p className="mb-2">
+          Under RA 10173, you have the right to:
+        </p>
+        <ul className="list-disc pl-6 space-y-1">
+          <li>Be informed about how your data is used</li>
+          <li>Access the personal information we hold about you</li>
+          <li>Correct inaccurate or incomplete information</li>
+          <li>Request erasure of your personal information</li>
+          <li>Object to or withdraw consent for further processing</li>
+        </ul>
+        <p className="mt-2">
+          To exercise any of these rights, email us at{' '}
+          <a href="mailto:privacy@pipetgo.com" className="underline text-green-700">
+            privacy@pipetgo.com
+          </a>
+          . We will respond within 15 days. Data deletion requests are handled manually at
+          this stage; self-service deletion will be available in a future release.
+        </p>
+      </section>
+
+      <section className="mb-8">
+        <h2 className="text-xl font-semibold mb-2">7. Contact</h2>
+        <p>
+          For questions about this notice or our data practices, contact our Data Privacy
+          Officer at{' '}
+          <a href="mailto:privacy@pipetgo.com" className="underline text-green-700">
+            privacy@pipetgo.com
+          </a>
+          .
+        </p>
+      </section>
+
+      <p className="text-xs text-gray-400 mt-12">
+        This notice is a stub for the initial PR and is subject to legal review before
+        PipetGo accepts its first commercial transaction.
+      </p>
+    </main>
+  )
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/app/privacy/page.tsx
@@ -0,0 +1,6 @@
+// Static RSC — no auth required. Reachable from the consent checkbox before authentication
+// so clients can read the notice during order creation and from unauthenticated marketing surfaces. (ref: DL-006)
+// Data-subject rights (access, rectification, erasure, withdrawal) are exercised via manual email
+// to the controller at the address below — self-service deletion is not available; submit a deletion request to the email address listed above. (ref: DL-007)
+// Consent revocation/withdrawal mechanics (RA 10173 §34 prospective revocation) are not implemented;
+// this page establishes write-once consent at order creation only. (ref: DL-013)

```


**CC-M-001-007** (src/domain/orders/__tests__/client-details.test.ts) - implements CI-M-001-007

**Code:**

```diff
--- /dev/null
+++ b/src/domain/orders/__tests__/client-details.test.ts
@@ -0,0 +1,52 @@
+import { describe, it, expect } from "vitest"
+import { ServiceCategory } from "@prisma/client"
+import { clientDetailsSchema, SENSITIVE_SERVICE_CATEGORIES, isSensitiveServiceCategory } from "../client-details"
+
+const validContact = {
+  name: "Test Client",
+  email: "test@example.com",
+  phone: "+639171234567",
+}
+
+describe("clientDetailsSchema — RA 10173 consent", () => {
+  it("rejects when consentGiven is false", () => {
+    const result = clientDetailsSchema.safeParse({ ...validContact, consentGiven: false })
+    expect(result.success).toBe(false)
+    if (!result.success) {
+      expect(result.error.flatten().fieldErrors.consentGiven).toBeDefined()
+    }
+  })
+
+  it("rejects when consentGiven is missing", () => {
+    const result = clientDetailsSchema.safeParse(validContact)
+    expect(result.success).toBe(false)
+    if (!result.success) {
+      expect(result.error.flatten().fieldErrors.consentGiven).toBeDefined()
+    }
+  })
+
+  it("accepts when consentGiven is true", () => {
+    const result = clientDetailsSchema.safeParse({ ...validContact, consentGiven: true as const })
+    expect(result.success).toBe(true)
+    if (result.success) {
+      expect(result.data.consentGiven).toBe(true)
+    }
+  })
+})
+
+describe("SENSITIVE_SERVICE_CATEGORIES — enum-drift fence (DL-011)", () => {
+  it("classifies CHEMICAL_TESTING and BIOLOGICAL_TESTING as sensitive and the remaining four categories as non-sensitive", () => {
+    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.CHEMICAL_TESTING]).toBe(true)
+    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.BIOLOGICAL_TESTING]).toBe(true)
+    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.PHYSICAL_TESTING]).toBe(false)
+    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.ENVIRONMENTAL_TESTING]).toBe(false)
+    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.CALIBRATION]).toBe(false)
+    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.CERTIFICATION]).toBe(false)
+  })
+
+  it("covers every ServiceCategory enum member (compile-time satisfies guard + runtime length fence)", () => {
+    expect(Object.keys(SENSITIVE_SERVICE_CATEGORIES).sort()).toEqual(
+      Object.values(ServiceCategory).sort()
+    )
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/domain/orders/__tests__/client-details.test.ts
@@ -0,0 +1,3 @@
+// Three-case fence for z.literal(true): false-rejection and missing-rejection lock the literal
+// semantics so a refactor downgrading to z.boolean() cannot pass tests green. (ref: DL-010)
+// Enum-drift fence covers every ServiceCategory member; compile-time satisfies guard + runtime length check. (ref: DL-011)

```


**CC-M-001-008** (src/domain/orders/CLAUDE.md)

**Documentation:**

```diff
--- a/src/domain/orders/CLAUDE.md
+++ b/src/domain/orders/CLAUDE.md
@@ -8,5 +8,5 @@ Domain kernel for order business rules.
 | File                | What                                                           | When to read                                                |
 | ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
 | `state-machine.ts`  | `validStatusTransitions` map + `isValidStatusTransition()`     | Writing any action that mutates `Order.status`              |
-| `client-details.ts` | `clientDetailsSchema` (Zod) + `ClientDetails` type             | Adding client contact fields; validating at action boundary |
+| `client-details.ts` | `clientDetailsSchema` (Zod) + `ClientDetails` type; `SENSITIVE_SERVICE_CATEGORIES` record + `isSensitiveServiceCategory()` — compile-time enum-drift fence for RA 10173 sensitivity classification | Adding client contact fields; modifying RA 10173 consent validation; classifying a new `ServiceCategory` as sensitive or non-sensitive |
 | `pricing.ts`        | `resolveOrderInitialState()` — maps `PricingMode` to initial order state | Creating orders; understanding FIXED vs QUOTE_REQUIRED flow |

```

