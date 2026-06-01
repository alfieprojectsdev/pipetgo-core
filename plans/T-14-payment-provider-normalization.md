# Plan

## Overview

XenditInvoicePayload leaks into webhooks/handlers.ts, and webhook static-token auth lives inline in route.ts. Migrating inbound capture to PayMongo (HMAC-SHA256 + timestamp) or HitPay (HMAC) requires editing handlers.ts and route.ts, defeating ADR-001 slice portability and AD-002 multi-processor strategy.

**Approach**: Introduce a provider-agnostic NormalizedWebhookPayload at src/lib/payments/types.ts and a webhook auth verifier module at src/lib/payments/webhook-auth.ts (verifyXenditToken live; verifyPayMongoHmac + verifyHitPayHmac as forward-compat stubs). webhooks/types.ts retains XenditInvoicePayload for raw body parsing and gains a normalizeXenditInvoicePayload adapter. webhooks/route.ts owns provider knowledge end-to-end: verify token via verifyXenditToken, parse XenditInvoicePayload, dispatch by status, normalize, call handlers with NormalizedWebhookPayload. webhooks/handlers.ts accepts only NormalizedWebhookPayload and constructs failureReason as a hardcoded provider-specific string (Xendit invoice EXPIRED). domain/payments/events.ts JSDoc rewritten provider-agnostic. payouts/route.ts is intentionally untouched (different event type, follow-on cleanup).

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Locate normalization boundary at webhooks/route.ts, not inside handlers.ts | route.ts already owns provider knowledge (XENDIT_WEBHOOK_TOKEN env, x-callback-token header name, XenditInvoicePayload shape) -> moving normalization into handlers would force handlers to know which provider sent the raw payload, defeating the portability goal -> route.ts is the single boundary that translates provider-specific raw input to NormalizedWebhookPayload, so handlers.ts can be provider-agnostic and a new PayMongo route reuses handlers unchanged. |
| DL-002 | NormalizedWebhookPayload omits the status field; carries only externalId and optional paymentMethod | status routing happens at route.ts dispatch (PAID -> processPaymentCapture, EXPIRED -> processPaymentFailed) -> by the time handlers receive a normalized payload, the status is already encoded in which handler was invoked -> carrying status into handlers would be a dead field, and constructing failureReason from payload.status would re-leak Xendit terminology; instead each handler hardcodes its own provider-specific failure string until a future ticket abstracts that too. |
| DL-003 | Implement verifyPayMongoHmac and verifyHitPayHmac as forward-compat stubs in webhook-auth.ts even though no route wires them yet | AD-002 requires zero-edit migration to PayMongo/HitPay for handlers.ts and domain -> writing verifier signatures now ensures the auth abstraction is concrete (callable function signatures) rather than aspirational (interface only) -> implementing the HMAC algorithm bodies for both providers means a PayMongo migration only needs route.ts + paymongo.ts client, with no auth-layer scaffolding work pushed to a future ticket. |
| DL-004 | Keep verifyXenditToken signature accepting (req: NextRequest, secret: string) and place it alongside provider-agnostic verifiers in webhook-auth.ts | Xendit verification reads only the x-callback-token header (no body) -> verifier signature passes the whole NextRequest so future per-provider verifiers can read whatever headers they need (PayMongo reads paymongo-signature; HitPay reads hitpay-signature) -> uniform (req, secret) entry shape lets route.ts code be structurally identical across providers, with only the verifier-import switching. |
| DL-005 | Leave idempotency key construction (xendit:invoice:PAID|EXPIRED:{externalId}) in handlers with hardcoded provider prefix; do not abstract key format in T-14 | Changing the deployed key format requires migrating idempotency_keys rows and updating T-16 tests in lockstep -> T-14 scope is type boundary only, not idempotency contract evolution -> keep the xendit: prefix in handlers as an acceptable provider-leak until T-17 (PESONet) forces a formal key namespace decision. |
| DL-006 | Leave payouts/route.ts untouched in T-14; do not adopt verifyXenditToken there | payouts/route.ts processes XenditSettlementPayload (a different event type from XenditInvoicePayload) -> normalizing settlement at the same time as invoice capture conflates two unrelated provider boundaries and expands test surface significantly -> adopt verifyXenditToken in payouts/route.ts as a tiny follow-on cleanup PR once T-14 lands and the verifier function is in the codebase. |
| DL-007 | Hardcode failureReason in processPaymentFailed as Xendit invoice EXPIRED, dropping the dynamic payload.status interpolation | processPaymentFailed is only ever invoked for EXPIRED dispatch (route.ts switches on status before invoking) -> the dynamic string Xendit invoice ${payload.status} can only resolve to Xendit invoice EXPIRED in production -> hardcoding the literal removes the last handler-level dependency on payload.status without changing observable behavior (test assertion /EXPIRED/ still passes). |
| DL-008 | Preserve the buffer-length precondition for crypto.timingSafeEqual inside verifyXenditToken; do not delegate to timingSafeEqual alone | crypto.timingSafeEqual throws RangeError on unequal-length buffers -> dropping the explicit length check would convert any short token submission into an uncaught 500 instead of a clean 401 -> the length-check && timingSafeEqual pattern is a load-bearing invariant for the verifier (captured in invisible_knowledge.invariants and risk R-004) and must move into verifyXenditToken as a single composed predicate, not be relied upon at the call site. |
| DL-009 | Do not introduce a PaymentProvider interface, factory, or registry; export verifiers as plain named functions | AD-002 explicitly invokes YAGNI on PaymentProvider abstraction -> NormalizedWebhookPayload + per-provider verifier functions deliver the same migration property (zero-edit to handlers) with strictly less surface area -> a factory would force routes to know their provider name as a string key, which is a worse coupling than the import they already have. |
| DL-010 | Locate normalizeXenditInvoicePayload in webhooks/types.ts (Xendit-specific adapter), not in src/lib/payments/types.ts (shared interface) | src/lib/payments/types.ts owns only the provider-agnostic shape (NormalizedWebhookPayload) -> adapters that translate from a provider-specific raw payload to the agnostic shape are provider-specific concerns -> co-locating normalizeXenditInvoicePayload with XenditInvoicePayload in the webhooks slice keeps the adapter next to the type it depends on and avoids polluting lib/payments/types.ts with N adapters as providers are added. |
| DL-011 | Test payload migration is a required test maintenance update, not a regression - handlers.test.ts and handlers-rollback.test.ts payload literals shift from XenditInvoicePayload to NormalizedWebhookPayload | Handler signatures change from XenditInvoicePayload to NormalizedWebhookPayload as part of T-14 -> any test that constructs a payload literal must update field shape (id -> externalId, drop status/paid_amount/payer_email, payment_method -> paymentMethod) -> the change is non-substantive (same business scenarios, same assertions, only the payload-construction syntax shifts) so it counts as required test maintenance not as breaking the test contract. v1->v2 audit-trail note: v1 of this decision predicated on tests breaking; v2 reframes as required maintenance because the assertion set is unchanged - only payload construction syntax differs. No prior content lost; clarification only. |
| DL-012 | Add direct unit tests for verifyPayMongoHmac and verifyHitPayHmac in M-001 even though no route wires them | DL-003 elevates the HMAC verifiers from interface-only stubs to full implementations (timestamp parsing, HMAC-SHA256, header parsing) -> full implementations are non-trivial untested code that would surface bugs only at T-17 PayMongo migration, with no signal until then -> add positive (known-good HMAC), negative (mutated body), missing-header, and stale-timestamp tests directly against the verifiers in M-001 so algorithm correctness is verified at T-14 merge time, not deferred to T-17. |
| DL-013 | Use a 300-second timestamp freshness tolerance for verifyPayMongoHmac and require the implementer JSDoc to cite the PayMongo webhook docs URL inline | PayMongo signs webhooks with header format t={timestamp},te={testSig},li={liveSig} where {timestamp} is unix seconds; a freshness window prevents replay of an old signed payload after secret rotation -> 300 seconds matches industry convention (Stripe Webhooks uses 300s, the PayMongo docs example uses 300s) and gives clock-skew headroom without leaving an unbounded replay window -> verifier behavior under this tolerance must be documented in the verifier JSDoc with an inline link to https://developers.paymongo.com/docs/webhooks (anchor for the third-party API contract) so any change to PayMongo's header format is caught by reading webhook-auth.ts in isolation. |
| DL-014 | verifyXenditToken returns false when the expected secret argument is empty string, regardless of the received header value | An empty expected secret would pass the buffer-length check (length 0 === length 0) and crypto.timingSafeEqual would return true for an empty received header, creating a silent auth bypass if route.ts ever stopped guarding XENDIT_WEBHOOK_TOKEN -> the verifier contract should be safe on its own (defense in depth) - it cannot assume the caller validated the secret -> add an explicit `if (!secret) return false;` guard at the top of verifyXenditToken; route.ts retains the 500-before-call env guard as the primary defense and 'unset env returns 500' contract for ops visibility. |
| DL-015 | normalizeXenditInvoicePayload throws Error('Xendit payload missing required id field') when payload.id is null/empty/non-string; route.ts catches and returns 400 | A malformed Xendit payload with null or empty id would propagate to Transaction.findUnique({ where: { externalId: null } }) and crash with PrismaClientValidationError, causing Xendit to retry the same malformed payload indefinitely -> the normalization boundary is the right place to fail-fast on contract violations because it is the first code that asserts the provider-specific shape -> throwing a typed Error at the adapter, caught by route.ts and converted to 400 JSON, tells Xendit to stop retrying and surfaces the contract violation in logs without polluting handlers with input-validation code. |
| DL-016 | Locate webhook-auth.ts in src/lib/payments/ alongside xendit.ts and the future paymongo.ts, not in src/lib/auth/ or src/features/payments/shared/ | Webhook auth is a per-payment-provider concern (each provider has its own signing scheme: Xendit static token, PayMongo HMAC+timestamp, HitPay HMAC) and is tightly coupled to the provider-client modules -> src/lib/auth/ owns user-session/JWT concerns (a different axis); src/features/payments/shared/ would force a feature-slice import for what is a cross-slice provider primitive -> co-locating webhook-auth.ts with provider clients in src/lib/payments/ keeps payment-provider concerns in one directory so adding a provider edits one location; the mix of inbound auth verifiers and outbound clients in the same directory is acceptable because both share the provider-config axis. |
| DL-017 | M-005 JSDoc-only edits to src/domain/payments/events.ts and src/domain/payments/CLAUDE.md are explicitly excluded from the 'zero changes to handlers.ts or domain/' portability invariant | Task_spec scope states 'zero changes to handlers.ts or domain/' as the portability property - the intent is that adding a new provider requires no behavioral or import change in those files -> M-005 removes stale 'PayMongo' terminology from domain/payments JSDoc to make it provider-agnostic; this is a stale-documentation cleanup with zero runtime impact and zero import-graph change -> scope 'domain/ changes' to mean behavioral or import-graph changes; doc-only edits that strip provider-specific terminology are explicitly permitted (and required for invariant integrity). This is documented here so implementers reading task_spec alongside M-005 do not flag M-005 as a scope violation. |
| DL-018 | src/lib/payments/webhook-auth.ts must not import Prisma, must not import from src/features/, and must not import from src/domain/; allowed imports are limited to 'node:crypto' and 'next/server' (NextRequest type) | webhook-auth.ts is a pure crypto/header-parsing module; pulling Prisma into it would create a circular-feeling dependency where lib/ knows about persistence -> pulling src/features/ or src/domain/ imports would invert the layering (lib/ depends on features/) and break the goal that any feature slice can import lib/ freely -> enforcing the import-set 'node:crypto' + 'next/server' keeps the module portable, trivially unit-testable, and impossible to silently couple to slice state; eslint no-restricted-imports can later enforce this if a violation is attempted. |
| DL-019 | src/lib/payments/webhook-auth.ts is a leaf module: handlers.ts, src/domain/, and __tests__ (other than webhook-auth.ts own unit tests) must never import from it — webhook-auth.ts is consumed only by per-provider route.ts files | DL-018 governs only the outbound import set FROM webhook-auth.ts (node:crypto + next/server) -> the portability goal also needs the reverse-direction guarantee that auth verification stays a route-level concern; if handlers.ts imported a verifier, handler logic would re-acquire provider-auth knowledge and a new provider could no longer reuse handlers unchanged -> assert the inbound restriction explicitly so route.ts is the single consumer of verifiers and the CI-M-001-001 module-level JSDoc claim has a decision backing rather than being attributed incorrectly to DL-018. |
| DL-020 | verifyHitPayHmac JSDoc must cite the official HitPay webhook signature spec URL https://docs.hitpayapp.com/api-reference/webhooks as the third-party contract anchor; the HMAC-SHA256-over-rawBody-with-salt algorithm is an ASSUMPTION_UNVALIDATED until verified against that spec at T-17 HitPay wiring | DL-003 mandates a full HMAC body for verifyHitPayHmac but no HitPay documentation is anchored anywhere in the plan, unlike PayMongo which DL-013 anchors to developers.paymongo.com -> an incorrect HitPay algorithm or header-field name would compile and pass its own unit test (the test would use the same wrong algorithm) yet silently reject every real HitPay webhook, surfacing only at T-17 -> require the verifyHitPayHmac JSDoc to carry the HitPay docs URL inline so the algorithm is auditable against the third-party contract by reading webhook-auth.ts alone, and record that the stub algorithm is ASSUMPTION_UNVALIDATED pending T-17 sandbox verification. |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Introduce a PaymentProvider interface and factory/registry that handlers dispatch through | YAGNI per roadmap AD-002 - NormalizedWebhookPayload plus per-provider verifier functions deliver the same zero-edit migration property with strictly less surface area; a factory would force routes to know their provider name as a string key, a worse coupling than the named-import they already have (ref: DL-009) |
| Move webhook auth into Next.js middleware | Overkill - per-route token ownership is cleaner; route.ts already imports its own env var (XENDIT_WEBHOOK_TOKEN) and reads its own header (x-callback-token); a middleware layer would need to dispatch by URL pattern to pick the right verifier and adds an extra hop with no abstraction win. Aligns with existing settlement handler pattern (ref: DL-001) |
| Normalize the settlement (payouts) handler in this ticket alongside invoice capture | XenditSettlementPayload is a different event type from XenditInvoicePayload; conflating two unrelated provider boundaries in one ticket expands test surface significantly and defers neither work usefully. Deferred to a follow-on cleanup PR once T-14 verifier function is in the codebase (ref: DL-006) |
| Change idempotency key format to drop the xendit: prefix (provider-agnostic key namespace) | Changing the deployed key format requires migrating idempotency_keys rows and updating T-16 tests in lockstep; T-14 scope is the type boundary only, not idempotency contract evolution. Keep xendit: prefix in handlers as an acceptable provider-leak until T-17 (PESONet) forces a formal key namespace decision (ref: DL-005) |

### Constraints

- C-001 (MUST): processPaymentCapture and processPaymentFailed must not import XenditInvoicePayload after refactor
- C-002 (MUST): route.ts is the only file referencing XenditInvoicePayload after normalization
- C-003 (MUST): verifyXenditToken, verifyPayMongoHmac, verifyHitPayHmac all implemented in webhook-auth.ts (PayMongo + HitPay can be stubs - not wired to any route)
- C-004 (MUST): npx tsc --noEmit passes after refactor
- C-005 (MUST): existing webhook integration tests pass (test payload shapes change from XenditInvoicePayload to NormalizedWebhookPayload - this is a required update, not a test break)
- C-006 (MUST NOT): introduce PaymentProvider interface or factory
- C-007 (MUST NOT): touch payouts/settlement handler (out of scope)

### Known Risks

- **verifyPayMongoHmac and verifyHitPayHmac are fully implemented forward-compat verifiers (HMAC-SHA256, timestamp parsing) but have zero unit-test coverage; bugs in algorithm/header-format logic surface only at T-17 PayMongo migration with no prior signal**: Add direct unit tests for verifyPayMongoHmac and verifyHitPayHmac in M-001 (positive case with known-good HMAC, negative case with mutated body, negative case with empty/missing header, negative case with stale timestamp); see DL-012
- **XENDIT_WEBHOOK_TOKEN env var unset/empty in production - verifyXenditToken would accept any empty-string token through the length check, producing a silent auth bypass if route.ts 500-guard regresses**: verifyXenditToken returns false when the expected secret argument is empty string regardless of received header value; route.ts retains the 500-before-call env guard as defense-in-depth; see DL-014
- **normalizeXenditInvoicePayload trusts payload.id and payload.payment_method without runtime validation - a malformed Xendit payload with null/empty id would propagate to Transaction.findUnique({ where: { externalId: null } }) and crash with PrismaClientValidationError, causing infinite Xendit retries**: normalizeXenditInvoicePayload throws Error('Xendit payload missing required id field') when payload.id is null/empty/non-string; route.ts catches and returns 400 so Xendit stops retrying. Documented as DL-015 malformed-payload policy
- **Buffer-length precondition for crypto.timingSafeEqual is a load-bearing invariant (RangeError on unequal lengths) - if a future refactor drops the length check, short-token requests become uncaught 500s instead of clean 401s**: Preserve length-check && timingSafeEqual as a single composed predicate inside verifyXenditToken; assert this invariant in invisible_knowledge.invariants so future maintainers see the constraint
- **PayMongo signature header format (t={timestamp},te={testEnv},li={liveEnv}) is encoded in CI-M-001-001 but no official PayMongo webhook docs are anchored in reference_docs - if the format is wrong, verifyPayMongoHmac silently returns false for all valid payloads at T-17 migration**: JSDoc on verifyPayMongoHmac cites the PayMongo webhook docs URL at implementation time; T-17 migration plan must validate end-to-end against PayMongo sandbox before declaring done; see DL-013
- **verifyHitPayHmac implements HMAC-SHA256 over rawBody with a salt, but the HitPay webhook signature algorithm and signing-header field name are ASSUMPTION_UNVALIDATED — no official HitPay webhook spec was cited at plan time. An incorrect algorithm or header name compiles and passes its own unit test (the test reuses the same wrong algorithm) yet silently rejects every real HitPay webhook, surfacing only at T-17 HitPay wiring.**: verifyHitPayHmac JSDoc cites the official HitPay webhook docs URL https://docs.hitpayapp.com/api-reference/webhooks inline as the third-party contract anchor and records the algorithm as ASSUMPTION_UNVALIDATED; the T-17 HitPay migration plan must validate end-to-end against the HitPay sandbox before declaring done; see DL-020.

## Invisible Knowledge

### System

T-14 introduces a single normalization boundary at webhooks/route.ts that translates each provider's raw webhook payload into a provider-agnostic NormalizedWebhookPayload before invoking handlers. Three layers participate: (1) src/lib/payments/types.ts defines NormalizedWebhookPayload (the shared shape, no provider state); (2) src/lib/payments/webhook-auth.ts exports one verifier per inbound provider (verifyXenditToken live; verifyPayMongoHmac and verifyHitPayHmac as forward-compat stubs ready for T-17 wiring); (3) per-provider feature slices (webhooks/, future paymongo/, future hitpay/) own a route.ts that calls the appropriate verifier, parses the provider-specific payload, dispatches by status, and normalizes via a co-located per-provider adapter (normalizeXenditInvoicePayload lives in webhooks/types.ts, not lib/). handlers.ts and src/domain/payments/ are provider-agnostic and never import provider-specific symbols. The migration property: adding a new inbound provider requires only adding a verifier body in webhook-auth.ts, a new provider client in src/lib/payments/, and a new route.ts plus per-provider adapter - zero edits to handlers.ts or src/domain/. Cross-cutting concerns deliberately scoped out of T-14: idempotency key namespace (xendit: prefix stays in handlers per DL-005, deferred to T-17), payouts/settlement normalization (different event type per DL-006), PaymentProvider interface/factory (YAGNI per DL-009 / AD-002).

### Invariants

- Normalization boundary MUST be at route.ts - route is the only file that knows which provider's raw payload it received; pushing normalization into handlers defeats the portability goal
- route.ts is the only file in the codebase that may reference XenditInvoicePayload after T-14 (constraint C-002, load-bearing for the AD-002 portability goal); handlers.ts, domain/payments/, and __tests__ must never import XenditInvoicePayload — if any of them did, that file would re-acquire Xendit-specific knowledge and a new provider could no longer reuse it unchanged. Future refactors detect a boundary violation by grepping XenditInvoicePayload across src/ and confirming only webhooks/types.ts and webhooks/route.ts match.
- crypto.timingSafeEqual requires equal-length buffers - the length check (tokenBuf.length === expectedBuf.length &&) is a precondition and must remain inside verifyXenditToken as a single composed predicate; dropping it converts short-token requests into uncaught 500s instead of clean 401s
- processPaymentFailed is only ever called for EXPIRED events (route.ts dispatches it only on that branch) - hardcoding 'Xendit invoice EXPIRED' as failureReason is semantically correct, not a regression
- payouts/route.ts uses the same static-token auth pattern as webhooks/route.ts but is intentionally out of scope for T-14; adopt verifyXenditToken there as a tiny follow-on cleanup PR once T-14 lands
- normalizeXenditInvoicePayload lives in webhooks/types.ts (provider-specific adapter, co-located with XenditInvoicePayload), not in src/lib/payments/types.ts (which only owns the provider-agnostic shape)
- src/lib/payments/webhook-auth.ts must not import Prisma, must not import from src/features/, and must not import from src/domain/ — it is a pure crypto/header-parsing module; the only allowed imports are 'node:crypto' and 'next/server' (NextRequest type) (outbound rule, DL-018). It is also a leaf module in the reverse direction (DL-019): handlers.ts, src/domain/, and __tests__ other than webhook-auth.ts own unit tests must never import from webhook-auth.ts — route.ts is the single consumer of the verifiers, so auth verification stays a route-level concern and handlers remain provider-agnostic.
- src/domain/payments/events.ts and src/domain/payments/CLAUDE.md JSDoc-only edits in M-005 are explicitly excluded from the 'zero changes to handlers.ts or domain/' portability invariant - the invariant covers behavioral/import changes, not stale-doc cleanup that removes provider-specific terminology

### Tradeoffs

- Implement full HMAC bodies for verifyPayMongoHmac / verifyHitPayHmac now vs. signature-only stubs (DL-003 + DL-012): full implementations remove all auth scaffolding work from the T-17 migration and let unit tests run today against the algorithm; cost is non-trivial untested code in the tree until T-17 wires a route, mitigated by adding direct unit tests in M-001 (R-001) rather than relying on integration coverage that does not yet exist
- Retain hardcoded 'xendit:' idempotency key prefix in handlers (DL-005): trades a single remaining provider-leak (the prefix string) for avoiding a coupled migration of the deployed idempotency_keys table rows and T-16 tests. Acceptable until T-17 (PESONet) forces a formal key-namespace decision; invariant #5 marks the leak as deliberate so future maintainers do not 'fix' it
- Hardcode 'Xendit invoice EXPIRED' literal in processPaymentFailed (DL-007): trades a tiny per-handler provider string for the last handler-level dependency on payload.status; safe because dispatch already determined the status by the time the handler runs - the dynamic interpolation could only ever resolve to this literal in production
- Locate webhook-auth.ts in src/lib/payments/ rather than src/lib/auth/ or src/features/payments/shared/ (DL-016): keeps payment-provider concerns co-located with provider clients (xendit.ts, future paymongo.ts) so adding a provider edits one directory; cost is that src/lib/payments/ now mixes outbound client code and inbound auth verifier code, which is acceptable because both share the provider-config axis

## Milestones

### Milestone 1: Provider-agnostic types and verifier module

**Files**: src/lib/payments/types.ts, src/lib/payments/webhook-auth.ts, src/lib/payments/CLAUDE.md

**Requirements**:

- Define NormalizedWebhookPayload interface in src/lib/payments/types.ts with fields externalId:string and optional paymentMethod:string and no status field (DL-002); Create src/lib/payments/webhook-auth.ts exporting verifyXenditToken verifyPayMongoHmac verifyHitPayHmac (C-003); webhook-auth.ts imports only node:crypto and next/server — no Prisma no src/features no src/domain (DL-018); verifyXenditToken preserves the buffer-length precondition before crypto.timingSafeEqual (DL-008); verifyXenditToken returns false on empty secret (DL-014); Add types.ts and webhook-auth.ts rows to src/lib/payments/CLAUDE.md

**Acceptance Criteria**:

- npx tsc --noEmit passes with the new types.ts and webhook-auth.ts present (C-004); webhook-auth.ts source contains no import from @prisma/client src/features or src/domain; verifyXenditToken returns false when the secret argument is an empty string; verifyXenditToken returns false for a token of different length than the secret without throwing RangeError; src/lib/payments/CLAUDE.md lists both new files with read-when triggers

**Tests**:

- Unit: verifyXenditToken positive — matching token and secret returns true; Unit: verifyXenditToken negative — mismatched equal-length token returns false; Unit: verifyXenditToken negative — empty secret returns false regardless of header; Unit: verifyXenditToken negative — different-length token returns false without throwing; Unit: verifyPayMongoHmac positive — known-good HMAC over {timestamp}.{rawBody} returns true; Unit: verifyPayMongoHmac negative — mutated body returns false; Unit: verifyPayMongoHmac negative — missing or empty signature header returns false; Unit: verifyPayMongoHmac negative — timestamp older than 300s tolerance returns false; Unit: verifyHitPayHmac positive — known-good HMAC over rawBody returns true; Unit: verifyHitPayHmac negative — mutated body returns false

#### Code Intent

- **CI-M-001-001** `src/lib/payments/webhook-auth.ts`: Export three named verifier functions. verifyXenditToken(req: NextRequest, secret: string): boolean first returns false when secret is empty string (DL-014 defense-in-depth guard); otherwise reads the x-callback-token header (?? empty string), constructs Buffer from received and expected tokens, and returns tokenBuf.length === expectedBuf.length && crypto.timingSafeEqual(tokenBuf, expectedBuf). JSDoc cites DL-008 stating the buffer-length precondition is load-bearing for crypto.timingSafeEqual (RangeError on unequal lengths) and DL-014 explaining the empty-secret guard. verifyPayMongoHmac(rawBody: string, header: string, secret: string): boolean parses the PayMongo signature header format t={timestamp},te={testEnv},li={liveEnv}; validates timestamp freshness within the 300-second tolerance defined by DL-013; computes HMAC-SHA256 over the string {timestamp}.{rawBody} with the secret; performs constant-time comparison against the signature claim. JSDoc cites DL-013 and includes the inline PayMongo webhook docs URL https://developers.paymongo.com/docs/webhooks as the third-party API contract anchor. verifyHitPayHmac(rawBody: string, header: string, salt: string): boolean computes HMAC-SHA256 over rawBody with salt and performs constant-time comparison against the header value; JSDoc cites DL-020 and includes the inline HitPay webhook docs URL https://docs.hitpayapp.com/api-reference/webhooks as the third-party API contract anchor, and notes the HitPay algorithm is ASSUMPTION_UNVALIDATED pending T-17 sandbox verification against that spec. Module-level JSDoc states this file is the single location for inbound webhook auth across providers; per DL-018 it must not import Prisma nor anything from src/features/ or src/domain/ (allowed imports: node:crypto and next/server only); and per DL-019 it is a leaf module — handlers.ts, src/domain/, and __tests__ other than this module own unit tests must never import from here, so route.ts is the only consumer of the verifiers. (refs: DL-004, DL-008, DL-013, DL-014, DL-018, DL-020, DL-019)
- **CI-M-001-002** `src/lib/payments/types.ts`: Export NormalizedWebhookPayload interface with fields { externalId: string; paymentMethod?: string }. Module-level JSDoc states this is the provider-agnostic shape consumed by webhook handlers and produced by per-provider normalizer adapters; no status field because dispatch happens at route level before normalization. No runtime code, type definitions only. (refs: DL-002)
- **CI-M-001-003** `src/lib/payments/CLAUDE.md`: Files index table includes two new rows: types.ts (NormalizedWebhookPayload provider-agnostic shape; consumed by webhook handlers; read when adding a new provider or changing handler-facing payload contract) and webhook-auth.ts (verifyXenditToken + verifyPayMongoHmac + verifyHitPayHmac; one verifier per inbound provider; read when wiring a new provider route or rotating webhook secret). (refs: DL-016)

#### Code Changes

**CC-M-001-001** (src/lib/payments/webhook-auth.ts) - implements CI-M-001-001

**Code:**

```diff
--- a/src/lib/payments/webhook-auth.ts
+++ b/src/lib/payments/webhook-auth.ts
@@ -0,0 +1,96 @@
+/**
+ * Per-provider inbound webhook authentication verifiers.
+ *
+ * This is the single location for webhook auth across all providers. Each verifier
+ * is a named function — no factory or interface — because provider auth strategies
+ * are structurally different (static token vs HMAC) and an abstraction is not
+ * justified until a second provider is live. (ref: AD-002, rejected-alternative: PaymentProvider factory)
+ *
+ * Allowed imports: node:crypto and next/server only. Must not import from @/features/,
+ * @/domain/, or @prisma/client. (ref: DL-018)
+ *
+ * Leaf module — route.ts is the only consumer. handlers.ts, src/domain/, and any
+ * __tests__ other than this module's own unit tests must never import from here.
+ * (ref: DL-019)
+ */
+import crypto from 'node:crypto'
+import type { NextRequest } from 'next/server'
+
+/**
+ * Verifies a Xendit webhook x-callback-token header against the provided secret.
+ *
+ * Returns false immediately when secret is empty string — defense-in-depth guard
+ * so a misconfigured env var cannot accidentally pass verification. (ref: DL-014)
+ *
+ * Buffer length check is a load-bearing precondition for crypto.timingSafeEqual:
+ * equal-length buffers are required or timingSafeEqual throws RangeError. The check
+ * is not an optimisation — it is a correctness requirement. (ref: DL-008)
+ *
+ * Accepts (req, secret) so callers pass the env-read secret explicitly — coupling
+ * route.ts env reads to this verifier would make unit-testing without env stubs
+ * impossible. (ref: DL-004)
+ */
+export function verifyXenditToken(req: NextRequest, secret: string): boolean {
+  if (!secret) return false
+  const token = req.headers.get('x-callback-token') ?? ''
+  const tokenBuf = Buffer.from(token)
+  const secretBuf = Buffer.from(secret)
+  return (
+    tokenBuf.length === secretBuf.length &&
+    crypto.timingSafeEqual(tokenBuf, secretBuf)
+  )
+}
+
+/**
+ * Verifies a PayMongo webhook signature header against the provided secret.
+ *
+ * Header format: t={timestamp},te={testEnvSig},li={liveEnvSig}
+ * Signed payload: {timestamp}.{rawBody}
+ * Algorithm: HMAC-SHA256, constant-time comparison.
+ * Timestamp tolerance: 300 seconds (ref: DL-013).
+ *
+ * API contract anchor: https://developers.paymongo.com/docs/webhooks (ref: DL-013)
+ *
+ * Not wired to any route until T-17 (PayMongo migration).
+ */
+export function verifyPayMongoHmac(
+  rawBody: string,
+  header: string,
+  secret: string,
+): boolean {
+  if (!secret || !header) return false
+  const parts: Record<string, string> = {}
+  for (const part of header.split(',')) {
+    const eq = part.indexOf('=')
+    if (eq !== -1) parts[part.slice(0, eq)] = part.slice(eq + 1)
+  }
+  const timestamp = parts['t']
+  const sigClaim = parts['li'] ?? parts['te']
+  if (!timestamp || !sigClaim) return false
+  const ts = parseInt(timestamp, 10)
+  if (isNaN(ts)) return false
+  const now = Math.floor(Date.now() / 1000)
+  if (Math.abs(now - ts) > 300) return false
+  const signed = `${timestamp}.${rawBody}`
+  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex')
+  const expectedBuf = Buffer.from(expected)
+  const claimBuf = Buffer.from(sigClaim)
+  return (
+    expectedBuf.length === claimBuf.length &&
+    crypto.timingSafeEqual(expectedBuf, claimBuf)
+  )
+}
+
+/**
+ * Verifies a HitPay webhook signature against the provided salt.
+ *
+ * Algorithm: HMAC-SHA256 over rawBody with salt, constant-time comparison.
+ *
+ * ASSUMPTION_UNVALIDATED: the HitPay algorithm described here is pending sandbox
+ * verification against the HitPay webhook spec before T-17 wires this to a route.
+ * API contract anchor: https://docs.hitpayapp.com/api-reference/webhooks (ref: DL-020)
+ *
+ * Not wired to any route until a HitPay integration ticket is scheduled.
+ */
+export function verifyHitPayHmac(
+  rawBody: string,
+  header: string,
+  salt: string,
+): boolean {
+  if (!salt || !header) return false
+  const expected = crypto.createHmac('sha256', salt).update(rawBody).digest('hex')
+  const expectedBuf = Buffer.from(expected)
+  const headerBuf = Buffer.from(header)
+  return (
+    expectedBuf.length === headerBuf.length &&
+    crypto.timingSafeEqual(expectedBuf, headerBuf)
+  )
+}
```

**Documentation:**

```diff
--- a/src/lib/payments/webhook-auth.ts
+++ b/src/lib/payments/webhook-auth.ts
@@ -46,6 +46,8 @@
  * Header format: t={timestamp},te={testEnvSig},li={liveEnvSig}
  * Signed payload: {timestamp}.{rawBody}
+ * `rawBody` must be the raw request body text read before `JSON.parse` —
+ * re-serializing a parsed body breaks the HMAC-SHA256 comparison.
  * Algorithm: HMAC-SHA256, constant-time comparison.
  * Timestamp tolerance: 300 seconds (ref: DL-013).

```


**CC-M-001-002** (src/lib/payments/types.ts) - implements CI-M-001-002

**Code:**

```diff
--- a/src/lib/payments/types.ts
+++ b/src/lib/payments/types.ts
@@ -0,0 +1,16 @@
+/**
+ * Shared payment types — provider-agnostic interfaces consumed by feature slices.
+ *
+ * Route handlers normalize provider-specific payloads into these types before
+ * dispatching to handlers. Handlers depend only on these types, not on any
+ * provider SDK shape. (ref: T-14 normalization boundary)
+ *
+ * Must not import from @/features/ or @/domain/; this is infrastructure.
+ */
+
+/**
+ * Normalized shape passed from a webhook route handler to processPaymentCapture
+ * and processPaymentFailed. Contains only the fields the handlers need; raw
+ * provider fields (status, paid_amount, payer_email) are consumed in route.ts.
+ */
+export interface NormalizedWebhookPayload {
+  externalId: string
+  paymentMethod?: string
+}
```

**Documentation:**

```diff
--- a/src/lib/payments/types.ts
+++ b/src/lib/payments/types.ts

```


**CC-M-001-003** (src/lib/payments/CLAUDE.md) - implements CI-M-001-003

**Code:**

```diff
--- a/src/lib/payments/CLAUDE.md
+++ b/src/lib/payments/CLAUDE.md
@@ -1,9 +1,11 @@
 # payments/
 
 Payment gateway HTTP clients. One file per provider.
 
 ## Files
 
-| File         | What                                                                  | When to read                                                    |
-| ------------ | --------------------------------------------------------------------- | --------------------------------------------------------------- |
-| `xendit.ts`  | Xendit Invoice API client — `createXenditInvoice`, `XenditApiError`   | Modifying Xendit integration or adding Xendit-specific params   |
+| File               | What                                                                                                     | When to read                                                                      |
+| ------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
+| `xendit.ts`        | Xendit Invoice API client — `createXenditInvoice`, `XenditApiError`                                      | Modifying Xendit integration or adding Xendit-specific params                     |
+| `types.ts`         | `NormalizedWebhookPayload` — provider-agnostic payload interface passed from route handlers to handlers  | Adding fields to the normalized payload or changing the handler contract          |
+| `webhook-auth.ts`  | Per-provider webhook auth verifiers — `verifyXenditToken` (live), `verifyPayMongoHmac`/`verifyHitPayHmac` (stubs) | Adding a new provider verifier or modifying Xendit token verification |
```

**Documentation:**

```diff
--- a/src/lib/payments/CLAUDE.md
+++ b/src/lib/payments/CLAUDE.md

```


### Milestone 2: Xendit normalization adapter and route refactor

**Files**: src/features/payments/webhooks/types.ts, src/features/payments/webhooks/route.ts

**Requirements**:

- Retain XenditInvoicePayload interface in webhooks/types.ts; Add normalizeXenditInvoicePayload adapter in webhooks/types.ts producing NormalizedWebhookPayload (DL-010); normalizeXenditInvoicePayload throws a typed Error when payload.id is null empty or non-string (DL-015); route.ts delegates auth to verifyXenditToken from @/lib/payments/webhook-auth (DL-001); route.ts catches the normalizer typed Error and returns 400 JSON (DL-015); route.ts is the only file referencing XenditInvoicePayload after normalization (C-002)

**Acceptance Criteria**:

- npx tsc --noEmit passes after the route and adapter refactor (C-004); grep for XenditInvoicePayload across src returns only webhooks/types.ts and webhooks/route.ts (C-002); route.ts returns 500 JSON when XENDIT_WEBHOOK_TOKEN is unset; route.ts returns 401 JSON when verifyXenditToken returns false; route.ts returns 400 JSON when normalizeXenditInvoicePayload throws; route.ts dispatches PAID to processPaymentCapture and EXPIRED to processPaymentFailed each with a NormalizedWebhookPayload argument

**Tests**:

- Integration: route.ts unset XENDIT_WEBHOOK_TOKEN yields 500; Integration: route.ts invalid x-callback-token yields 401; Integration: route.ts malformed payload with null id yields 400; Integration: route.ts PAID status invokes processPaymentCapture with normalized payload; Integration: route.ts EXPIRED status invokes processPaymentFailed with normalized payload; Integration: route.ts unknown status acknowledges without processing and returns received:true

#### Code Intent

- **CI-M-002-001** `src/features/payments/webhooks/types.ts`: Retain XenditInvoicePayload interface (id, status, paid_amount, payer_email, payment_method?). Add normalizeXenditInvoicePayload(payload: XenditInvoicePayload): NormalizedWebhookPayload — pure function returning { externalId: payload.id, paymentMethod: payload.payment_method }. JSDoc states this adapter is the Xendit-specific translation layer; it co-locates with XenditInvoicePayload (not lib/payments/) because per-provider adapters belong with their provider type. normalizeXenditInvoicePayload throws Error('Xendit payload missing required id field') when payload.id is null, empty string, or non-string (DL-015). (refs: DL-010, DL-015)
- **CI-M-002-002** `src/features/payments/webhooks/route.ts`: POST handler reads XENDIT_WEBHOOK_TOKEN from env and returns 500 JSON when absent (unset-env contract per DL-014). Auth check delegates to verifyXenditToken(req, expected) imported from @/lib/payments/webhook-auth and returns 401 JSON on false. Parses request body as XenditInvoicePayload (await req.json()). Uppercases payload.status and throws when empty so Xendit retries. Switch on status: PAID -> processPaymentCapture(normalizeXenditInvoicePayload(payload)); EXPIRED -> processPaymentFailed(normalizeXenditInvoicePayload(payload)); default -> console.info acknowledged-without-processing. normalizeXenditInvoicePayload may throw Error for a malformed payload (DL-015); route.ts wraps the normalize+dispatch path in try/catch and returns 400 JSON on that typed error so Xendit stops retrying. Returns { received: true } JSON. Preserves all console.info log lines from the current implementation (id and status in dispatch logs). Module-level JSDoc cites DL-001 (route.ts is the normalization boundary) and DL-008 (buffer-length precondition preserved inside verifyXenditToken). (refs: DL-001, DL-015, DL-008)

#### Code Changes

**CC-M-002-001** (src/features/payments/webhooks/types.ts) - implements CI-M-002-001

**Code:**

```diff
--- a/src/features/payments/webhooks/types.ts
+++ b/src/features/payments/webhooks/types.ts
@@ -1,13 +1,27 @@
 /**
- * Shape of the Xendit invoice webhook payload.
- * Shared by route.ts (parse + cast) and handlers.ts (process).
- * Defined once here to prevent silent type divergence between the two files.
+ * Xendit-specific webhook types.
+ *
+ * XenditInvoicePayload is the raw shape of the Xendit invoice callback body.
+ * route.ts parses and casts to this type, then normalizes to NormalizedWebhookPayload
+ * before dispatching to handlers. handlers.ts never imports this type.
  */
+import type { NormalizedWebhookPayload } from '@/lib/payments/types'
+
 export interface XenditInvoicePayload {
   id: string
   status: string
   paid_amount: number
   payer_email: string
   payment_method?: string
 }
+
+/**
+ * Xendit-specific adapter. Co-locates with XenditInvoicePayload because per-provider
+ * adapters belong with their provider type, not in lib/payments/. (ref: DL-010)
+ *
+ * Throws when payload.id is null, empty, or non-string so malformed payloads are
+ * rejected at the route boundary with a 400 rather than propagating as a 500. (ref: DL-015)
+ */
+export function normalizeXenditInvoicePayload(raw: XenditInvoicePayload): NormalizedWebhookPayload {
+  if (!raw.id || typeof raw.id !== 'string') {
+    throw new Error('Xendit payload missing required id field')
+  }
+  return {
+    externalId: raw.id,
+    paymentMethod: raw.payment_method,
+  }
+}
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/types.ts
+++ b/src/features/payments/webhooks/types.ts

```


**CC-M-002-002** (src/features/payments/webhooks/route.ts) - implements CI-M-002-002

**Code:**

```diff
--- a/src/features/payments/webhooks/route.ts
+++ b/src/features/payments/webhooks/route.ts
@@ -1,59 +1,58 @@
 /**
  * Xendit invoice webhook POST handler.
  *
- * Authenticates via x-callback-token header (static token, not HMAC).
- * PAID dispatches to processPaymentCapture; EXPIRED to processPaymentFailed.
- * Unknown statuses are acknowledged without processing; missing status throws. (ref: DL-009)
+ * route.ts is the normalization boundary: it verifies provider auth, parses the raw
+ * XenditInvoicePayload, normalizes to NormalizedWebhookPayload, then dispatches to
+ * handlers. Handlers receive only NormalizedWebhookPayload — no Xendit-specific types
+ * cross the route/handler boundary. (ref: DL-001)
+ *
+ * verifyXenditToken preserves the buffer-length precondition inside its implementation
+ * so callers need only pass (req, secret). (ref: DL-008)
  *
  * $transaction errors propagate as 500 to trigger Xendit's automatic retry.
  * No auth() call — webhook is server-to-server; token header is the only credential. (ref: DL-007)
  */
 import { NextRequest, NextResponse } from 'next/server'
-import crypto from 'crypto'
 import { processPaymentCapture, processPaymentFailed } from './handlers'
-import type { XenditInvoicePayload } from './types'
+import { type XenditInvoicePayload, normalizeXenditInvoicePayload } from './types'
+import { verifyXenditToken } from '@/lib/payments/webhook-auth'
 
 export async function POST(req: NextRequest): Promise<NextResponse> {
-  const expected = process.env.XENDIT_WEBHOOK_TOKEN
-  if (!expected) {
+  const secret = process.env.XENDIT_WEBHOOK_TOKEN
+  if (!secret) {
     return NextResponse.json({ error: 'Webhook token not configured.' }, { status: 500 })
   }
-
-  const token = req.headers.get('x-callback-token') ?? ''
-  const tokenBuf = Buffer.from(token)
-  const expectedBuf = Buffer.from(expected)
-  // Buffer length check required before timingSafeEqual — equal-length is a precondition.
-  // timingSafeEqual prevents timing attacks on constant-time comparison. (ref: DL-002)
-  const tokensMatch =
-    tokenBuf.length === expectedBuf.length &&
-    crypto.timingSafeEqual(tokenBuf, expectedBuf)
-
-  if (!tokensMatch) {
+  if (!verifyXenditToken(req, secret)) {
     return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
   }
 
   const payload = (await req.json()) as XenditInvoicePayload
 
   const status = (payload.status ?? '').toUpperCase()
   console.info(`[webhook] received payload id=${payload.id} status=${status}`)
 
   if (status === '') {
     throw new Error('Xendit webhook missing payload.status')
   }
 
+  let normalized
+  try {
+    normalized = normalizeXenditInvoicePayload(payload)
+  } catch (err) {
+    if (err instanceof Error) {
+      return NextResponse.json({ error: err.message }, { status: 400 })
+    }
+    throw err
+  }
+
   switch (status) {
     case 'PAID':
       console.info(`[webhook] dispatch to processPaymentCapture id=${payload.id}`)
-      await processPaymentCapture(payload)
+      await processPaymentCapture(normalized)
       break
     case 'EXPIRED':
       console.info(`[webhook] dispatch to processPaymentFailed id=${payload.id}`)
-      await processPaymentFailed(payload)
+      await processPaymentFailed(normalized)
       break
     default:
       console.info(`[webhook] acknowledged-without-processing id=${payload.id} status=${status}`)
   }
 
   return NextResponse.json({ received: true })
 }
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/route.ts
+++ b/src/features/payments/webhooks/route.ts

```


### Milestone 3: Handler signature change to NormalizedWebhookPayload

**Files**: src/features/payments/webhooks/handlers.ts

**Requirements**:

- processPaymentCapture and processPaymentFailed accept NormalizedWebhookPayload from @/lib/payments/types; Remove the XenditInvoicePayload import from handlers.ts (C-001); processPaymentFailed sets failureReason to the hardcoded literal Xendit invoice EXPIRED (DL-007); idempotencyKey retains the hardcoded xendit: prefix (DL-005); handlers.ts reads only payload.externalId and payload.paymentMethod — never payload.id status paid_amount or payer_email

**Acceptance Criteria**:

- npx tsc --noEmit passes after the handler signature change (C-004); handlers.ts contains no import of XenditInvoicePayload (C-001); processPaymentFailed writes failureReason exactly Xendit invoice EXPIRED; idempotency keys are xendit:invoice:PAID:{externalId} and xendit:invoice:EXPIRED:{externalId}; all idempotency layers status guards and the $transaction boundary are structurally unchanged

**Tests**:

- Integration (M-004): processPaymentCapture with NormalizedWebhookPayload completes capture and PaymentCapturedEvent fan-out; Integration (M-004): processPaymentFailed with NormalizedWebhookPayload sets failureReason matching /EXPIRED/; Integration (M-004): repeated PAID delivery is deduped via IdempotencyKey; Integration (M-004): cross-event PAID vs EXPIRED keys are isolated

#### Code Intent

- **CI-M-003-001** `src/features/payments/webhooks/handlers.ts`: processPaymentCapture and processPaymentFailed accept NormalizedWebhookPayload imported from @/lib/payments/types; remove the import of XenditInvoicePayload (C-001). Inside processPaymentCapture the idempotencyKey is constructed as xendit:invoice:PAID:${payload.externalId} with the hardcoded xendit: prefix retained per DL-005 (deliberate provider-leak deferred to T-17); findUnique on Transaction by externalId uses payload.externalId; transaction.update sets paymentMethod: payload.paymentMethod ?? null; PaymentCapturedEvent populates paymentMethod: payload.paymentMethod and gatewayRef: transaction.externalId. Inside processPaymentFailed the idempotencyKey is constructed as xendit:invoice:EXPIRED:${payload.externalId} (same DL-005 prefix); transaction.update sets failureReason to the hardcoded literal Xendit invoice EXPIRED per DL-007 (processPaymentFailed only fires on EXPIRED dispatch so the literal is semantically correct); all console.info log lines keep payload.externalId replacing the prior payload.id and payload.status references. All idempotency layers, orphan tolerance, FAILED/CAPTURED status guards, $transaction boundary, isValidStatusTransition check, handlePaymentCaptured fan-out, and IdempotencyKey.create at end of transaction remain structurally unchanged. (refs: DL-002, DL-005, DL-007)

#### Code Changes

**CC-M-003-001** (src/features/payments/webhooks/handlers.ts) - implements CI-M-003-001

**Code:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -1,14 +1,14 @@
 /**
  * Payment capture and failure processors for Xendit invoice webhooks.
  *
  * processPaymentCapture and processPaymentFailed run all DB writes inside a single Prisma $transaction.
  * Any throw at any step rolls back all writes; Xendit retries on 500 reattempt the full capture.
  * (ref: DL-001, DL-004, DL-006)
  */
 import { OrderStatus, TransactionStatus } from '@prisma/client'
 import { prisma } from '@/lib/prisma'
 import { PaymentCapturedEvent } from '@/domain/payments/events'
 import { handlePaymentCaptured } from '@/features/orders/handle-payment-captured/handler'
 import { isValidStatusTransition } from '@/domain/orders/state-machine'
-import type { XenditInvoicePayload } from './types'
+import type { NormalizedWebhookPayload } from '@/lib/payments/types'
 
 /**
  * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, and dispatches
@@ -21,19 +21,19 @@
  * Returns early (200 to caller) if Transaction is not found (orphan tolerance) or
  * already CAPTURED (idempotency). Both guards are inside the transaction boundary
  * to prevent race conditions from concurrent Xendit deliveries. (ref: DL-004, DL-007)
  */
-export async function processPaymentCapture(payload: XenditInvoicePayload): Promise<void> {
+export async function processPaymentCapture(payload: NormalizedWebhookPayload): Promise<void> {
   await prisma.$transaction(async (tx) => {
-    const idempotencyKey = `xendit:invoice:PAID:${payload.id}`
+    const idempotencyKey = `xendit:invoice:PAID:${payload.externalId}`
     const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
     if (existing) {
       console.info(`[processPaymentCapture] dedup key hit key=${idempotencyKey}`)
       return
     }
 
     // Lookup by externalId (Xendit invoice ID), not Transaction.id (our cuid). (ref: DL-004)
     // findUnique enforces the @unique constraint at query level (Implementation Discipline).
     const transaction = await tx.transaction.findUnique({
-      where: { externalId: payload.id },
+      where: { externalId: payload.externalId },
     })
 
     if (!transaction) {
@@ -53,9 +53,9 @@
     if (transaction.status === TransactionStatus.FAILED) {
       // EXPIRED-then-PAID concurrent delivery: refuse to overwrite terminal FAILED with CAPTURED. (ref: R-007)
-      console.info(`[processPaymentCapture] received PAID for FAILED transaction id=${payload.id}`)
+      console.info(`[processPaymentCapture] received PAID for FAILED transaction id=${payload.externalId}`)
       throw new Error(`Refusing to capture FAILED transaction ${transaction.id}: EXPIRED already terminal`)
     }
 
     const capturedAt = new Date()
 
     await tx.transaction.update({
       where: { id: transaction.id },
       data: {
         status: TransactionStatus.CAPTURED,
         capturedAt,
-        paymentMethod: payload.payment_method ?? null,
+        paymentMethod: payload.paymentMethod ?? null,
       },
     })
 
     // amount from Transaction.amount (Decimal), not payload.paid_amount (float) —
     // avoids floating-point drift; amount was validated at checkout creation. (ref: DL-005)
     const event: PaymentCapturedEvent = {
       orderId: transaction.orderId,
       transactionId: transaction.id,
       amount: transaction.amount,
       gatewayRef: transaction.externalId,
       capturedAt,
-      paymentMethod: payload.payment_method,
+      paymentMethod: payload.paymentMethod,
     }
 
     // Delegates Order.status transition to orders slice — ADR-001 fan-out pattern. (ref: DL-001)
     await handlePaymentCaptured(event, tx)
 
     await tx.idempotencyKey.create({ data: { key: idempotencyKey } })
   })
 }
 
 /**
  * Marks Transaction FAILED and transitions Order PAYMENT_PENDING→PAYMENT_FAILED.
  * Mirrors processPaymentCapture: same $transaction boundary, orphan tolerance,
  * idempotency-by-terminal-status. (ref: DL-001)
  * No LabWallet write — failed payments produce no lab credit. (ref: DL-007)
  */
-export async function processPaymentFailed(payload: XenditInvoicePayload): Promise<void> {
-  console.info(`[processPaymentFailed] enter id=${payload.id} status=${payload.status}`)
+export async function processPaymentFailed(payload: NormalizedWebhookPayload): Promise<void> {
+  console.info(`[processPaymentFailed] enter id=${payload.externalId}`)
 
   await prisma.$transaction(async (tx) => {
-    const idempotencyKey = `xendit:invoice:EXPIRED:${payload.id}`
+    const idempotencyKey = `xendit:invoice:EXPIRED:${payload.externalId}`
     const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
     if (existing) {
       console.info(`[processPaymentFailed] dedup key hit key=${idempotencyKey}`)
       return
     }
 
     // findUnique enforces the @unique constraint at query level (Implementation Discipline).
     const transaction = await tx.transaction.findUnique({
-      where: { externalId: payload.id },
+      where: { externalId: payload.externalId },
     })
 
     if (!transaction) {
-      console.info(`[processPaymentFailed] orphan tolerance id=${payload.id}`)
+      console.info(`[processPaymentFailed] orphan tolerance id=${payload.externalId}`)
       return
     }
 
     if (transaction.status === TransactionStatus.FAILED) {
       // Idempotency guard — inside $transaction to close concurrent-delivery race. (ref: DL-004)
-      console.info(`[processPaymentFailed] idempotent no-op id=${payload.id}`)
+      console.info(`[processPaymentFailed] idempotent no-op id=${payload.externalId}`)
       return
     }
 
     if (transaction.status === TransactionStatus.CAPTURED) {
       // PAID-then-EXPIRED concurrent delivery: refuse to mark a CAPTURED transaction as FAILED.
       // Symmetric guard to processPaymentCapture R-007. The state machine would throw below
       // (ACKNOWLEDGED→PAYMENT_FAILED is invalid), but this guard makes the intent explicit
       // so a future developer does not interpret the asymmetry as an oversight.
-      console.info(`[processPaymentFailed] received EXPIRED for CAPTURED transaction id=${payload.id}`)
+      console.info(`[processPaymentFailed] received EXPIRED for CAPTURED transaction id=${payload.externalId}`)
       return
     }
 
     await tx.transaction.update({
       where: { id: transaction.id },
       data: {
         status: TransactionStatus.FAILED,
-        failureReason: `Xendit invoice ${payload.status}`,
+        failureReason: 'Xendit invoice EXPIRED',
       },
     })
 
     const order = await tx.order.findUnique({
       where: { id: transaction.orderId },
     })
 
     if (!order) {
       throw new Error(`Order not found for orderId ${transaction.orderId} during EXPIRED processing`)
     }
 
     if (!isValidStatusTransition(order.status, OrderStatus.PAYMENT_FAILED)) {
       throw new Error(`Cannot transition Order ${order.id} from ${order.status} to PAYMENT_FAILED`)
     }
 
     await tx.order.update({
       where: { id: transaction.orderId },
       data: { status: OrderStatus.PAYMENT_FAILED },
     })
 
     await tx.idempotencyKey.create({ data: { key: idempotencyKey } })
   })
 }
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -26,3 +26,4 @@
   await prisma.$transaction(async (tx) => {
+    // xendit: prefix is intentional — format is deployed; changing it requires migrating idempotency_keys rows. (ref: DL-005)
     const idempotencyKey = `xendit:invoice:PAID:${payload.externalId}`
     const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
@@ -94,3 +95,4 @@
   await prisma.$transaction(async (tx) => {
+    // xendit: prefix is intentional — format is deployed; changing it requires migrating idempotency_keys rows. (ref: DL-005)
     const idempotencyKey = `xendit:invoice:EXPIRED:${payload.externalId}`
     const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })

```


#### Documentation

**Inline Comments**:

- `src/features/payments/webhooks/handlers.ts — at the idempotencyKey construction site in processPaymentCapture (xendit:invoice:PAID:) and processPaymentFailed (xendit:invoice:EXPIRED:)` (ref: DL-005): Deliberate provider-leak: the 'xendit:' idempotency-key prefix is intentionally hardcoded here, NOT an oversight. Abstracting the key namespace is explicitly deferred to T-17 (PESONet) per DL-005 — changing the deployed key format requires migrating idempotency_keys rows and updating T-16 tests in lockstep. Do not 'fix' this prefix in isolation: a key-format change without the row migration breaks dedup for every in-flight idempotency_keys row.

### Milestone 4: Test payload migration to NormalizedWebhookPayload

**Files**: src/features/payments/webhooks/__tests__/handlers.test.ts, src/features/payments/webhooks/__tests__/handlers-rollback.test.ts, src/features/payments/webhooks/__tests__/normalize.test.ts

**Requirements**:

- Migrate handlers.test.ts payload literals from XenditInvoicePayload to NormalizedWebhookPayload (DL-011); Migrate handlers-rollback.test.ts payload literals and align mock method names to handlers.ts call sites; Add normalize.test.ts unit coverage for normalizeXenditInvoicePayload (DL-015); All migrated test scenarios retain identical assertions (DL-011)

**Acceptance Criteria**:

- npm test -- --run passes all webhook tests (C-005); no test file imports or annotates XenditInvoicePayload after migration; handlers-rollback.test.ts mock method names match handlers.ts Prisma call sites exactly; normalize.test.ts asserts the malformed-id throw path; failureReason assertion toMatch(/EXPIRED/) still passes against the hardcoded literal

**Tests**:

- Migrated: all handlers.test.ts scenarios pass with NormalizedWebhookPayload literals; Migrated: all handlers-rollback.test.ts rollback assertions pass with aligned mock names; New: normalize.test.ts positive maps id to externalId and payment_method to paymentMethod; New: normalize.test.ts payment_method-absent yields undefined paymentMethod; New: normalize.test.ts null empty and non-string id each throw matching /missing required id/

#### Code Intent

- **CI-M-004-001** `src/features/payments/webhooks/__tests__/handlers.test.ts`: Replace XenditInvoicePayload type annotations on payload variables with NormalizedWebhookPayload (imported from @/lib/payments/types). Replace payload literal fields: id -> externalId, payment_method -> paymentMethod; drop status, paid_amount, payer_email fields (handlers no longer read them). All existing test scenarios (AD-001 no-wallet-write, pre-existing wallet unchanged, CAPTURED idempotency, IdempotencyKey PAID dedup, IdempotencyKey creation atomicity, FAILED guard R-007, EXPIRED key dedup, cross-event key isolation, FAILED transition + failureReason /EXPIRED/, FAILED idempotency, orphan tolerance, completeOrder Payout creation) retain identical assertions per DL-011 (test-payload migration is required maintenance, not a contract change). failureReason assertion expect(tx!.failureReason).toMatch(/EXPIRED/) continues to pass against the hardcoded Xendit invoice EXPIRED literal per DL-007. (refs: DL-002, DL-007, DL-011)
- **CI-M-004-002** `src/features/payments/webhooks/__tests__/handlers-rollback.test.ts`: Replace XenditInvoicePayload type annotation with NormalizedWebhookPayload (imported from @/lib/payments/types). Payload literals use { externalId: xendit-mock-ext, paymentMethod: undefined } (or paymentMethod omitted) instead of id/status/paid_amount/payer_email/payment_method. mockTxTransactionFindUnique returns { id, externalId: xendit-mock-ext, orderId, amount, status }; mock method names (idempotencyKey.findUnique, idempotencyKey.create, transaction.findUnique, transaction.update, order.findUnique, order.update) match handlers.ts call sites exactly per Implementation Discipline rule. Both processPaymentCapture rollback assertions (transaction.update failure propagation; idempotencyKey.create atomicity) and both processPaymentFailed rollback assertions (order.update failure propagation; idempotencyKey.create atomicity) retain identical reject expectations. (refs: DL-002, DL-011)
- **CI-M-004-003** `src/features/payments/webhooks/__tests__/normalize.test.ts`: New unit-test file covering normalizeXenditInvoicePayload (the new pure adapter in webhooks/types.ts). Positive case: a well-formed XenditInvoicePayload maps id -> externalId and payment_method -> paymentMethod; status/paid_amount/payer_email are dropped. payment_method-absent case: result.paymentMethod is undefined. Malformed-payload cases per DL-015: payload.id null throws Error matching /missing required id/; payload.id empty string throws; payload.id non-string throws. This gives the new adapter direct unit coverage rather than relying only on integration tests that exercise it indirectly. (refs: DL-015)

#### Code Changes

**CC-M-004-001** (src/features/payments/webhooks/__tests__/handlers.test.ts) - implements CI-M-004-001

**Code:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -1,8 +1,8 @@
 import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
 import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode, PayoutStatus } from '@prisma/client'
 import { testPrisma } from '@/test/test-prisma'
 import { processPaymentCapture, processPaymentFailed } from '../handlers'
 import { completeOrder } from '@/features/orders/lab-fulfillment/action'
-import type { XenditInvoicePayload } from '../types'
+import type { NormalizedWebhookPayload } from '@/lib/payments/types'
 
 vi.mock('@/lib/prisma', async () => {
   const { testPrisma: client } = await import('@/test/test-prisma')
@@ -137,11 +137,9 @@
     })
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: TEST_TX_EXTERNAL_ID_1,
+      externalId: TEST_TX_EXTERNAL_ID_1,
-      status: 'PAID',
-      paid_amount: 1500,
-      payer_email: 'client@test.local',
-      payment_method: 'CREDIT_CARD',
+      paymentMethod: 'CREDIT_CARD',
     }
 
     await processPaymentCapture(payload)
@@ -178,11 +176,8 @@
     })
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: TEST_TX_EXTERNAL_ID_2,
+      externalId: TEST_TX_EXTERNAL_ID_2,
-      status: 'PAID',
-      paid_amount: 1500,
-      payer_email: 'client@test.local',
     }
 
     await processPaymentCapture(payload)
@@ -214,11 +209,8 @@
     })
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: TEST_TX_EXTERNAL_ID_3,
+      externalId: TEST_TX_EXTERNAL_ID_3,
-      status: 'PAID',
-      paid_amount: 1500,
-      payer_email: 'client@test.local',
     }
 
     await processPaymentCapture(payload)
@@ -252,11 +244,8 @@
     })
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: TEST_TX_EXTERNAL_ID_5,
+      externalId: TEST_TX_EXTERNAL_ID_5,
-      status: 'PAID',
-      paid_amount: 1500,
-      payer_email: 'client@test.local',
     }
 
     await processPaymentCapture(payload)
@@ -293,11 +282,8 @@
     })
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: TEST_TX_EXTERNAL_ID_6,
+      externalId: TEST_TX_EXTERNAL_ID_6,
-      status: 'PAID',
-      paid_amount: 1500,
-      payer_email: 'client@test.local',
     }
 
     await processPaymentCapture(payload)
@@ -333,11 +319,8 @@
     })
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: TEST_TX_EXTERNAL_ID_4,
+      externalId: TEST_TX_EXTERNAL_ID_4,
-      status: 'PAID',
-      paid_amount: 1500,
-      payer_email: 'client@test.local',
     }
 
     await expect(processPaymentCapture(payload)).rejects.toThrow(/FAILED/)
@@ -443,11 +426,8 @@
     })
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: TEST_TX_EXTERNAL_ID_5,
+      externalId: TEST_TX_EXTERNAL_ID_5,
-      status: 'EXPIRED',
-      paid_amount: 0,
-      payer_email: 'client@test.local',
     }
 
     await processPaymentFailed(payload)
@@ -486,11 +466,8 @@
     })
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: TEST_TX_EXTERNAL_ID_6,
+      externalId: TEST_TX_EXTERNAL_ID_6,
-      status: 'EXPIRED',
-      paid_amount: 0,
-      payer_email: 'client@test.local',
     }
 
     await processPaymentFailed(payload)
@@ -530,11 +507,8 @@
     })
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: TEST_TX_EXTERNAL_ID_4,
+      externalId: TEST_TX_EXTERNAL_ID_4,
-      status: 'EXPIRED',
-      paid_amount: 0,
-      payer_email: 'client@test.local',
     }
 
     await processPaymentFailed(payload)
@@ -566,11 +540,8 @@
     })
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: TEST_TX_EXTERNAL_ID_4,
+      externalId: TEST_TX_EXTERNAL_ID_4,
-      status: 'EXPIRED',
-      paid_amount: 0,
-      payer_email: 'client@test.local',
     }
 
     await processPaymentFailed(payload)
@@ -583,11 +554,8 @@
   it('returns without error when Transaction is not found (orphan tolerance)', async () => {
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: 'xendit-unknown-ext-id',
+      externalId: 'xendit-unknown-ext-id',
-      status: 'EXPIRED',
-      paid_amount: 0,
-      payer_email: 'client@test.local',
     }
 
     await expect(processPaymentFailed(payload)).resolves.not.toThrow()
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts

```


**CC-M-004-002** (src/features/payments/webhooks/__tests__/handlers-rollback.test.ts) - implements CI-M-004-002

**Code:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
@@ -1,6 +1,6 @@
 import { describe, it, expect, vi } from 'vitest'
 import { Decimal } from '@prisma/client/runtime/library'
 import { OrderStatus, TransactionStatus } from '@prisma/client'
 
 const mockIdempotencyKeyFindUnique = vi.fn().mockResolvedValue(null)
 const mockIdempotencyKeyCreate = vi.fn().mockResolvedValue({ key: 'xendit:invoice:PAID:xendit-mock-ext' })
 const mockTxTransactionFindUnique = vi.fn().mockResolvedValue({
   id: 'mock-tx-id',
   externalId: 'xendit-mock-ext',
   orderId: 'mock-order-id',
   amount: new Decimal('750.00'),
   status: TransactionStatus.PENDING,
 })
 const mockTxTransactionUpdate = vi.fn().mockRejectedValue(new Error('transaction update failure'))
 const mockTxOrderFindUnique = vi.fn().mockResolvedValue({
   id: 'mock-order-id',
   status: OrderStatus.PAYMENT_PENDING,
 })
 const mockTxOrderUpdate = vi.fn().mockRejectedValue(new Error('order update failure'))
 
 const mockTx = {
   idempotencyKey: {
     findUnique: mockIdempotencyKeyFindUnique,
     create: mockIdempotencyKeyCreate,
   },
   transaction: {
     findUnique: mockTxTransactionFindUnique,
     update: mockTxTransactionUpdate,
   },
   order: {
     findUnique: mockTxOrderFindUnique,
     update: mockTxOrderUpdate,
   },
 }
 
 vi.mock('@/lib/prisma', () => ({
   prisma: {
     $transaction: vi.fn((callback: (tx: typeof mockTx) => Promise<void>) => callback(mockTx)),
   },
 }))
 
 vi.mock('@/features/orders/handle-payment-captured/handler', () => ({
   handlePaymentCaptured: vi.fn().mockResolvedValue(undefined),
 }))
 
 vi.mock('@/domain/orders/state-machine', () => ({
   isValidStatusTransition: vi.fn().mockReturnValue(true),
 }))
 
 import { processPaymentCapture, processPaymentFailed } from '../handlers'
-import type { XenditInvoicePayload } from '../types'
+import type { NormalizedWebhookPayload } from '@/lib/payments/types'
 
 describe('processPaymentCapture — rollback error propagation', () => {
   // Forces tx.transaction.update rejection to verify $transaction error propagation; no LabWallet mock needed under AD-001. (ref: DL-009)
   it('rejects with the transaction update error, confirming error propagation that triggers Prisma rollback', async () => {
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: 'xendit-mock-ext',
+      externalId: 'xendit-mock-ext',
-      status: 'PAID',
-      paid_amount: 750,
-      payer_email: 'lab@test.local',
     }
 
     await expect(processPaymentCapture(payload)).rejects.toThrow('transaction update failure')
   })
 
   it('rejects when idempotencyKey.create throws, confirming key creation participates in transaction atomicity (AC-006)', async () => {
     mockTxTransactionUpdate.mockResolvedValueOnce({})
     mockIdempotencyKeyCreate.mockRejectedValueOnce(new Error('idempotency-create-failure'))
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: 'xendit-mock-ext',
+      externalId: 'xendit-mock-ext',
-      status: 'PAID',
-      paid_amount: 750,
-      payer_email: 'lab@test.local',
     }
 
     await expect(processPaymentCapture(payload)).rejects.toThrow('idempotency-create-failure')
   })
 })
 
 describe('processPaymentFailed — rollback error propagation', () => {
   it('rejects when order.update throws, confirming error propagation triggers Prisma rollback', async () => {
     mockTxTransactionUpdate.mockResolvedValueOnce({})
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: 'xendit-mock-ext',
+      externalId: 'xendit-mock-ext',
-      status: 'EXPIRED',
-      paid_amount: 0,
-      payer_email: 'client@test.local',
     }
 
     await expect(processPaymentFailed(payload)).rejects.toThrow('order update failure')
   })
 
   it('rejects when idempotencyKey.create throws, confirming key creation participates in transaction atomicity (AC-006)', async () => {
     mockTxTransactionUpdate.mockResolvedValueOnce({})
     mockTxOrderUpdate.mockResolvedValueOnce({})
     mockIdempotencyKeyCreate.mockRejectedValueOnce(new Error('idempotency-create-failure'))
 
-    const payload: XenditInvoicePayload = {
+    const payload: NormalizedWebhookPayload = {
-      id: 'xendit-mock-ext',
+      externalId: 'xendit-mock-ext',
-      status: 'EXPIRED',
-      paid_amount: 0,
-      payer_email: 'client@test.local',
     }
 
     await expect(processPaymentFailed(payload)).rejects.toThrow('idempotency-create-failure')
   })
 })
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers-rollback.test.ts

```


**CC-M-004-003** (src/features/payments/webhooks/__tests__/normalize.test.ts) - implements CI-M-004-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/__tests__/normalize.test.ts
@@ -0,0 +1,51 @@
+import { describe, it, expect } from 'vitest'
+import { normalizeXenditInvoicePayload } from '../types'
+import type { XenditInvoicePayload } from '../types'
+
+describe('normalizeXenditInvoicePayload', () => {
+  it('maps id to externalId and payment_method to paymentMethod', () => {
+    const raw: XenditInvoicePayload = {
+      id: 'xendit-inv-abc',
+      status: 'PAID',
+      paid_amount: 1500,
+      payer_email: 'client@test.local',
+      payment_method: 'CREDIT_CARD',
+    }
+
+    const result = normalizeXenditInvoicePayload(raw)
+
+    expect(result.externalId).toBe('xendit-inv-abc')
+    expect(result.paymentMethod).toBe('CREDIT_CARD')
+  })
+
+  it('produces undefined paymentMethod when payment_method is absent', () => {
+    const raw: XenditInvoicePayload = {
+      id: 'xendit-inv-def',
+      status: 'EXPIRED',
+      paid_amount: 0,
+      payer_email: 'client@test.local',
+    }
+
+    const result = normalizeXenditInvoicePayload(raw)
+
+    expect(result.externalId).toBe('xendit-inv-def')
+    expect(result.paymentMethod).toBeUndefined()
+  })
+
+  it('throws when payload.id is null', () => {
+    const raw = { id: null, status: 'PAID', paid_amount: 0, payer_email: 'x@x.com' } as unknown as XenditInvoicePayload
+    expect(() => normalizeXenditInvoicePayload(raw)).toThrow(/missing required id/)
+  })
+
+  it('throws when payload.id is empty string', () => {
+    const raw: XenditInvoicePayload = { id: '', status: 'PAID', paid_amount: 0, payer_email: 'x@x.com' }
+    expect(() => normalizeXenditInvoicePayload(raw)).toThrow(/missing required id/)
+  })
+
+  it('throws when payload.id is a non-string value', () => {
+    const raw = { id: 12345, status: 'PAID', paid_amount: 0, payer_email: 'x@x.com' } as unknown as XenditInvoicePayload
+    expect(() => normalizeXenditInvoicePayload(raw)).toThrow(/missing required id/)
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/__tests__/normalize.test.ts
+++ b/src/features/payments/webhooks/__tests__/normalize.test.ts

```


### Milestone 5: Documentation and stale-JSDoc cleanup

**Files**: src/domain/payments/events.ts, src/domain/payments/CLAUDE.md, src/features/payments/webhooks/README.md, src/features/payments/webhooks/CLAUDE.md

**Requirements**:

- Rewrite src/domain/payments/events.ts JSDoc to be provider-agnostic with no PayMongo references (DL-003 DL-017); Update src/domain/payments/CLAUDE.md events.ts entry to provider-agnostic wording; Update webhooks/README.md request-flow and invariants sections for verifyXenditToken and normalization; Update webhooks/CLAUDE.md file index rows for route.ts handlers.ts and types.ts

**Acceptance Criteria**:

- src/domain/payments/events.ts contains no occurrence of the string PayMongo; src/domain/payments/CLAUDE.md events.ts entry contains no occurrence of PayMongo; webhooks/README.md request-flow describes verifyXenditToken auth and the normalizeXenditInvoicePayload step; webhooks/CLAUDE.md rows reflect NormalizedWebhookPayload handler signatures; events.ts and CLAUDE.md edits are JSDoc/docs-only with no behavioral or import-graph change (DL-017)

**Tests**:

- Doc-only milestone — verification is by grep: grep -c PayMongo src/domain/payments/events.ts returns 0; grep verifyXenditToken src/features/payments/webhooks/README.md returns a match; npx tsc --noEmit still passes confirming events.ts JSDoc edits did not alter types

#### Code Intent

- **CI-M-005-001** `src/domain/payments/events.ts`: Module-level JSDoc states these are provider-agnostic domain event types for webhook-driven payment transitions and the contract between domain/payments and feature-slice webhook handlers; webhook routes verify provider signatures, parse the raw provider payload, dispatch by status, normalize via per-provider adapters, and execute the resulting state transitions inside Prisma.$transaction; provider-specific signature-verification concerns live in src/lib/payments/webhook-auth.ts not here. No references to PayMongo by name in either the module-level JSDoc or the gatewayRef field comment (stale-terminology cleanup realizing DL-003 provider-agnostic events and DL-001 route-as-boundary). PaymentCapturedEvent and PaymentFailedEvent field shapes are unchanged; this is a JSDoc-only edit explicitly permitted by DL-017. (refs: DL-017)
- **CI-M-005-002** `src/domain/payments/CLAUDE.md`: Files index entry for events.ts states provider-agnostic domain event types consumed by webhook handlers and constructed inside per-provider routes after normalization, with no references to PayMongo by name (realizes DL-003 provider-agnostic events and DL-001 route-as-boundary; JSDoc/docs-only edit permitted by DL-017). commission.ts entry unchanged. (refs: DL-017)
- **CI-M-005-003** `src/features/payments/webhooks/README.md`: Request-flow section step 2 states route.ts verifies x-callback-token header against XENDIT_WEBHOOK_TOKEN env var via verifyXenditToken from @/lib/payments/webhook-auth (constant-time comparison with buffer-length precondition). Returns 401 on mismatch. Step 3 adds After dispatch, route.ts calls normalizeXenditInvoicePayload (defined in webhooks/types.ts) to construct a provider-agnostic NormalizedWebhookPayload before invoking processPaymentCapture or processPaymentFailed. Invariants section adds webhooks/handlers.ts imports zero provider-specific types; only route.ts references XenditInvoicePayload. Design decisions section adds AD-002 cross-reference: normalization layer abstracts payload shape and auth mechanism so a PayMongo migration only adds src/lib/payments/paymongo.ts plus src/features/payments/webhooks/paymongo/route.ts; zero edits to handlers.ts or src/domain. Design decisions section cites DL-003: verifyPayMongoHmac and verifyHitPayHmac are forward-compat stubs already present in webhook-auth.ts — any PayMongo/HitPay route addition requires zero changes to handlers.ts. (refs: DL-001, DL-003)
- **CI-M-005-004** `src/features/payments/webhooks/CLAUDE.md`: Files index row for route.ts states Next.js route handler; verifyXenditToken auth via webhook-auth module; XenditInvoicePayload parse and normalize to NormalizedWebhookPayload; exhaustive PAID/EXPIRED dispatch. Row for handlers.ts states processPaymentCapture and processPaymentFailed accept NormalizedWebhookPayload (provider-agnostic); no XenditInvoicePayload dependency. Row for types.ts states XenditInvoicePayload raw webhook body shape and normalizeXenditInvoicePayload adapter producing NormalizedWebhookPayload. (refs: DL-001)

#### Code Changes

**CC-M-005-001** (src/domain/payments/events.ts) - implements CI-M-005-001

**Code:**

```diff
--- a/src/domain/payments/events.ts
+++ b/src/domain/payments/events.ts
@@ -1,34 +1,32 @@
 /**
- * Domain event types for PayMongo webhook-driven payment transitions.
+ * Provider-agnostic domain event types for webhook-driven payment transitions.
  *
  * These types define the contract between the payments/ domain subdomain and
- * feature slice webhook handlers. Webhook routes dispatch raw PayMongo payloads
- * into these typed events; feature slice handlers execute the resulting state
- * transitions inside a Prisma.$transaction. (ref: DL-011)
+ * feature-slice webhook handlers. Webhook routes verify provider signatures, parse
+ * the raw provider payload, dispatch by status, normalize via per-provider adapters
+ * (src/features/payments/webhooks/types.ts), and produce these typed events inside
+ * Prisma.$transaction. Provider-specific auth concerns live in
+ * src/lib/payments/webhook-auth.ts, not here.
  *
- * NOTE: PayMongo webhook signature verification requires reading the raw request
- * body as text before JSON parsing. Re-serializing a parsed body breaks the
- * HMAC-SHA256 comparison.
  */
 import { Decimal } from "@prisma/client/runtime/library";
 
 export interface PaymentCapturedEvent {
   orderId: string;
   transactionId: string;
   amount: Decimal;
   gatewayRef: string;
-  // gatewayRef is captured here so dispute resolution and payout reconciliation
-  // can reference the gateway record without re-querying PayMongo.
+  // gatewayRef is the provider invoice ID captured here so dispute resolution
+  // and payout reconciliation can reference the gateway record without an
+  // additional provider query.
   capturedAt: Date;
-  // paymentMethod carried on the event so orders slice can write Order.paymentMethod
-  // without querying the Transaction model (cross-slice boundary violation). (ref: DL-009)
+  // paymentMethod carried on the event so the orders slice can write Order.paymentMethod
+  // without querying the Transaction model directly (cross-slice boundary).
   paymentMethod?: string;
 }
 
 export interface PaymentFailedEvent {
   orderId: string;
   transactionId: string;
   failureReason: string;
   failedAt: Date;
 }
```

**Documentation:**

```diff
--- a/src/domain/payments/events.ts
+++ b/src/domain/payments/events.ts

```


**CC-M-005-002** (src/domain/payments/CLAUDE.md) - implements CI-M-005-002

**Code:**

```diff
--- a/src/domain/payments/CLAUDE.md
+++ b/src/domain/payments/CLAUDE.md
@@ -5,6 +5,6 @@
 ## Files
 
 | File            | What                                                           | When to read                                                      |
 | --------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
-| `events.ts`     | `PaymentCapturedEvent` and `PaymentFailedEvent` interface types | Implementing webhook handlers; dispatching payment events to feature slices |
+| `events.ts`     | `PaymentCapturedEvent` and `PaymentFailedEvent` — provider-agnostic domain event types produced by webhook handlers after normalizing the raw provider payload | Implementing webhook handlers; dispatching payment events to feature slices |
 | `commission.ts` | `COMMISSION_RATE` — global commission rate Decimal constant for AD-001 Direct Payment fee arithmetic | Implementing Payout creation or modifying commission rate |
```

**Documentation:**

```diff
--- a/src/domain/payments/CLAUDE.md
+++ b/src/domain/payments/CLAUDE.md

```


**CC-M-005-003** (src/features/payments/webhooks/README.md) - implements CI-M-005-003

**Code:**

```diff
--- a/src/features/payments/webhooks/README.md
+++ b/src/features/payments/webhooks/README.md
@@ -8,9 +8,12 @@
 1. Xendit POSTs `{ id, status, paid_amount, payer_email, payment_method }` to
    `/api/webhooks/xendit`.
-2. `route.ts` verifies `x-callback-token` header against `XENDIT_WEBHOOK_TOKEN`
-   env var using `crypto.timingSafeEqual`. Returns 401 on mismatch.
-3. `route.ts` normalises `payload.status` to uppercase and dispatches:
+2. `route.ts` calls `verifyXenditToken` (from `@/lib/payments/webhook-auth`) with the
+   `x-callback-token` header and `XENDIT_WEBHOOK_TOKEN` env var. `verifyXenditToken`
+   uses `crypto.timingSafeEqual` with a buffer-length precondition. Returns 401 on
+   mismatch.
+3. `route.ts` normalises `payload.status` to uppercase and calls
+   `normalizeXenditInvoicePayload` (from `webhooks/types.ts`) to produce a
+   `NormalizedWebhookPayload`. Returns 400 on malformed payload (null/empty/non-string id).
+   Dispatches:
    - `PAID` → `processPaymentCapture`
    - `EXPIRED` → `processPaymentFailed`
    - Other non-empty statuses → acknowledged without processing (200, no DB write)
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/README.md
+++ b/src/features/payments/webhooks/README.md

```


**CC-M-005-004** (src/features/payments/webhooks/CLAUDE.md) - implements CI-M-005-004

**Code:**

```diff
--- a/src/features/payments/webhooks/CLAUDE.md
+++ b/src/features/payments/webhooks/CLAUDE.md
@@ -4,7 +4,7 @@
 ## Files
 
 | File          | Contents (WHAT)                                                                                  | Read When (WHEN)                                              |
 | ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
-| `route.ts`    | Next.js route handler; x-callback-token verification; exhaustive PAID/EXPIRED dispatch          | Modifying webhook auth or adding new Xendit event types       |
+| `route.ts`    | Next.js route handler; calls `verifyXenditToken` for auth; normalizes raw `XenditInvoicePayload` to `NormalizedWebhookPayload`; exhaustive PAID/EXPIRED dispatch | Modifying webhook auth or adding new Xendit event types |
 | `handlers.ts` | `processPaymentCapture` (PAID) — Transaction CAPTURED, Order fan-out, no LabWallet write (AD-001); `processPaymentFailed` (EXPIRED) — Transaction FAILED, Order PAYMENT_FAILED | Modifying payment capture or failure logic |
-| `types.ts`    | `XenditInvoicePayload` — webhook request body shape                                              | Adding fields from Xendit payload or modifying type contracts |
+| `types.ts`    | `XenditInvoicePayload` — raw Xendit webhook body shape; `normalizeXenditInvoicePayload` — adapter to `NormalizedWebhookPayload` | Adding Xendit payload fields or modifying the normalization adapter |
 | `README.md`   | Request flow, two-ID scheme, invariants, idempotency design                                      | Understanding capture lifecycle or debugging webhook behavior |
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/CLAUDE.md
+++ b/src/features/payments/webhooks/CLAUDE.md

```

