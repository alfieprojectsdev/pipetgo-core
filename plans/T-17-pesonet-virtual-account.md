# Plan

## Overview

B2B enterprise lab orders exceed InstaPay PHP 50,000 per-transaction ceiling; clients with large orders have no viable inbound payment option.

**Approach**: Add Xendit FVA as a payment method for orders above PHP 50k. Client selects a bank on order-detail, receives a VA number, bank-transfers the exact amount. Xendit VA payment webhook normalizes to NormalizedWebhookPayload via a new xendit-va route and dispatches to the existing processPaymentCapture handler unchanged.

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Use Xendit Fixed Virtual Account (FVA) API for PESONet payments, not Dynamic VA | Dynamic VA requires amount correlation at route layer after webhook delivery; FVA binds one VA number to one external_id for VA lifetime and enforces expected_amount -> Xendit only fires payment webhook when full expected_amount received -> prevents partial-amount CAPTURED transitions -> FVA eliminates amount reconciliation state from route layer |
| DL-002 | Store VA account_number in Transaction.vaNumber String? column, not Transaction.metadata JSON | VA account_number is primary client-facing data displayed on every order-detail render; metadata holds full Xendit response for audit trail -> conflating primary display data with audit data forces JSON cast on every RSC render and produces an untyped field at the query level -> vaNumber as a typed nullable column serializes cleanly in RSC DTOs and is directly SELECTable |
| DL-003 | Set FVA expected_amount to Transaction.amount (order.quotedPrice) at creation time | Xendit enforces expected_amount by only firing payment webhook when full amount received -> setting expected_amount prevents partial-amount bank transfers from triggering CAPTURED -> processPaymentCapture reads Transaction.amount (not webhook-reported amount) for PaymentCapturedEvent, so amount source-of-truth stays in DB regardless of what Xendit reports in the callback. |
| DL-004 | Add idempotencyKeyPrefix string? to NormalizedWebhookPayload; handlers.ts uses payload.idempotencyKeyPrefix ?? xendit:invoice for key construction | VA payment events need xendit:va:PAID:{id} key — not xendit:invoice:PAID:{id} — to avoid misleading product labels -> handlers.ts cannot produce correct VA key without knowing the product prefix -> idempotencyKeyPrefix: string? in NormalizedWebhookPayload is the minimal additive change (backward compat via ?? fallback) -> only two one-liner changes in handlers.ts, zero business logic changes. The ?? 'xendit:invoice' fallback is NOT a silent contract violation: both invoice and VA route.ts files explicitly provide idempotencyKeyPrefix in the payload they construct -> undefined prefix can only occur during rolling deploy where old route.ts delivers to new handlers.ts -> fallback preserves pre-T-17 correct behavior in that window; throwing would break all invoice webhooks during deploy. |
| DL-005 | Reuse verifyXenditToken from webhook-auth.ts for VA webhook auth — no new verifier | Xendit uses the same x-callback-token static header mechanism for both invoice and FVA payment callbacks -> adding a duplicate verifier would violate the one-verifier-per-auth-mechanism structure of webhook-auth.ts with no functional benefit -> webhook-auth.ts is unchanged. The XENDIT_WEBHOOK_TOKEN environment variable is shared between the invoice webhook route and the VA webhook route -> a single token covers both callback endpoints as documented by Xendit's callback authentication model. |
| DL-006 | Place initiateVaCheckout as a separate Server Action in checkout/action.ts, not extending initiateCheckout | Invoice and VA flows diverge at Xendit API call (step 3), idempotency guard (checkoutUrl redirect vs order-detail redirect), and Transaction shape (vaNumber, no checkoutUrl) -> a discriminator branch makes both paths harder to read and test independently -> two named actions are explicit, independently testable, and consistent with the VSA pattern of one-concern-per-export. |
| DL-007 | Redirect initiateVaCheckout to /dashboard/orders/{orderId} after VA creation, not /dashboard/orders/{orderId}/pay | VA checkout has no hosted payment page to redirect to; the client needs the VA number displayed on their order -> redirect to order-detail is the correct landing page where VA instructions are shown -> /dashboard/orders/{orderId}/pay is the Xendit invoice checkout route, which is irrelevant for VA flow -> redirect() is the last statement after try/catch, preserving Implementation Discipline invariant |
| DL-008 | Bank selector UI lives on order-detail page for PAYMENT_PENDING orders above PHP 50k | Bank is a payment-time decision, not an order-creation decision; consistent with existing Pay button placement on order-detail -> moving to create-order would require storing bank intent on Order before payment initiated -> order-detail already has PAYMENT_PENDING action surface (Pay button, retry CTA) making it the natural location |
| DL-009 | Define PesonetBankCode allowlist and PESONET_MIN_AMOUNT constant in src/domain/payments/pesonet.ts | Bank allowlist and threshold are business rules, not UI concerns -> domain location prevents arbitrary bank_code injection through checkout action -> domain module is imported by both the checkout action (server-side validation) and order-detail page (UI gate) without ADR-001 violations -> single source of truth for PesonetBankCode and PESONET_MIN_AMOUNT in domain layer. |
| DL-010 | Idempotency key prefix for VA events: xendit:va (resolves T-14 DL-005) | xendit:va:PAID:{externalId} and xendit:va:EXPIRED:{externalId} follow the documented provider:product:event:externalId format in schema.prisma comment -> clear product discriminator prevents future operator confusion when querying idempotency_keys table -> xendit:invoice prefix is reserved exclusively for invoice events — no namespace collision. |
| DL-011 | normalizeXenditVaPayload maps callback_virtual_account_id to NormalizedWebhookPayload.externalId, not payload.external_id | Two-ID scheme: Transaction.externalId stores Xendit FVA ID (from va.id in creation response); VA payment webhook delivers callback_virtual_account_id = that FVA ID -> processPaymentCapture looks up Transaction by findUnique({ where: { externalId } }) -> externalId in normalized payload must equal the Xendit FVA ID stored at creation time -> payload.external_id is our transactionId cuid, not what was stored |
| DL-012 | FVA expiration_date set to 72 hours from creation using Date arithmetic, not date-fns | date-fns is absent from package.json -> using new Date(Date.now() + 72 * 60 * 60 * 1000) avoids adding a dependency for a single arithmetic operation -> 72h expiry prevents indefinitely dangling PENDING Transactions; client can retry if expired (VA EXPIRED webhook transitions Order to PAYMENT_FAILED, existing retry CTA from T-08 handles recovery) |
| DL-013 | VA webhook route at src/features/payments/webhooks/xendit-va/route.ts with app-router mount at src/app/api/webhooks/xendit-va/route.ts | Mirrors invoice webhook slice structure exactly (features/payments/webhooks/route.ts + app/api/webhooks/xendit/route.ts) -> VA is a distinct Xendit event type with different payload shape; co-locating with invoice route would conflate two event types in one file -> VSA discipline: one slice per provider event type |
| DL-014 | order-detail page.tsx adds Transaction include to Prisma query for VA number display | Exploration confirmed order-detail currently queries Order with service, lab, clientProfile only; no Transaction include -> VA number lives on Transaction.vaNumber -> adding include: { transactions: { orderBy: { createdAt: desc }, take: 1 } } retrieves the most recent Transaction for the order -> vaNumber and paymentMethod from Transaction are added to OrderDetailDTO as typed string-or-null fields The include uses orderBy: { createdAt: 'desc' }, take: 1 to retrieve only the most recent Transaction. If a client has a PAYMENT_FAILED order and retries (via retryPayment which transitions to PAYMENT_PENDING), a second Transaction may be created on the next initiateVaCheckout — this produces two Transaction rows for the same Order. take: 1 with createdAt desc ensures the UI displays the most recent VA number, not an older expired one. This is intentional: only the latest transaction reflects the current payment attempt; older transactions are historical and not actionable. |
| DL-015 | Guard initiateVaCheckout against any existing PENDING Transaction (regardless of type) and rely on 72h FVA expiry for orphaned-VA cleanup | FVA collision (two concurrent initiateVaCheckout calls) blocked by checking for any PENDING Transaction before Xendit call -> if one exists, return error message (prevents duplicate VA creation). Orphaned-VA scenario (DB write fails after Xendit FVA creation) is architecturally contained: if Xendit call succeeds but DB write fails -> FVA expires after 72h -> EXPIRED webhook arrives as a no-op (no Transaction found) -> Order remains at PAYMENT_FAILED -> client can retry via existing retry CTA from T-08. Distinct-type guard (invoice vs VA PENDING) is not required -> a PAYMENT_PENDING order with any existing PENDING Transaction means a payment attempt is in flight -> dual-payment-attempt is a business logic violation regardless of type. |
| DL-016 | Set is_closed: true on FVA creation to enforce single-payment binding | Xendit FVA with is_closed: false allows the same VA number to accept multiple deposits at different times -> each deposit fires a payment webhook independently -> is_closed: true enforces that the VA accepts exactly one full payment matching expected_amount, then auto-closes -> prevents double-credit events: a second bank transfer to the same VA after the first CAPTURED webhook would fire a second payment webhook with no matching PENDING Transaction -> is_closed: true makes this scenario impossible by closing the VA after first payment. |
| DL-017 | Use transactionId cuid (our createId() output) as Xendit FVA external_id parameter at creation | Mirrors existing initiateCheckout pattern: a new cuid is generated before the Xendit call -> used as both Transaction.id and Xendit's external_id -> our record and Xendit's record are correlated by the same cuid in both systems. For VA: this cuid becomes Xendit's external_id reference -> Xendit's returned FVA id (raw.id) is stored as Transaction.externalId -> consistent with two-ID scheme: Transaction.externalId always holds the Xendit-returned identifier. The cuid as external_id also serves as audit trail -> Xendit payment webhook delivers external_id in payload which can identify the originating transaction context. |
| DL-018 | Convert order.quotedPrice (Prisma.Decimal) to JavaScript number via .toNumber() for Xendit FVA expected_amount — not .toFixed(2) or string | Xendit FVA API requires expected_amount as a JSON number (not string); Prisma.Decimal.toFixed(2) returns string which Xendit rejects. .toNumber() produces the float that Xendit expects. Precision: PHP peso amounts for PESONet (minimum 50,000 PHP) are well within Number.MAX_SAFE_INTEGER (9,007,199,254,740,991 PHP) — precision loss is impossible at this scale. quotedPrice values that exceed Number.MAX_SAFE_INTEGER cannot arise from valid orders in this system (Prisma Decimal precision cap is 65 digits, but lab test pricing is bounded by business logic to realistic PHP ranges). Rounding policy: quotedPrice is stored as Decimal(10,2) in schema — always an exact two-decimal value; .toNumber() on a two-decimal Decimal produces an exact IEEE 754 double for amounts in the PHP range, no rounding occurs. PESONet does not require integer amounts — PHP centavos (fractions of peso) are permitted. RSC DTO serialization rule (.toFixed(2)) applies to React RSC boundary only; the Xendit API call is server-side and requires number type. |
| DL-019 | VA webhook route dispatches on XenditVaPayload.status: 'COMPLETED' routes to processPaymentCapture; 'EXPIRED' routes to processPaymentFailed; 'FAILED' routes to processPaymentFailed; all other values return 200 no-op | Xendit FVA payment callback delivers status='COMPLETED' (not 'PAID' or 'SETTLED') when bank transfer received in full -> Xendit uses 'PAID' for invoice (e-payment) callbacks — FVA callbacks use 'COMPLETED' per Xendit FVA docs. 'SETTLED' is a payout/disbursement status, not applicable to incoming VA payments -> mapping 'COMPLETED' to processPaymentCapture advances Transaction to CAPTURED and Order to ACKNOWLEDGED. Xendit FVA expiry callback delivers status='EXPIRED' at the same callback URL -> signals no payment arrived before the 72h window -> routes to processPaymentFailed -> transitions Order to PAYMENT_FAILED; existing retry CTA from T-08 handles recovery. Xendit FVA may deliver status='FAILED' for rejected/bounced bank transfers -> also routes to processPaymentFailed. No-op 200 for PENDING/ACTIVE (informational) and unrecognized status values -> prevents Xendit retry storms on future status additions. Dispatch logic stays in route.ts -> maintains the normalization boundary -> handlers.ts remains agnostic to Xendit-specific status strings. |
| DL-020 | NormalizedWebhookPayload.paymentMethod for VA set to the bank_code string (e.g. 'BPI', 'BDO') — not a generic 'PESONET_VA' constant | paymentMethod in NormalizedWebhookPayload is passed to PaymentCapturedEvent -> stored on Transaction.paymentMethod for display and reconciliation. Using specific bank_code ('BPI', 'BDO') preserves granular bank identity -> order-detail VA instructions component reads transactionPaymentMethod to display bank name -> bank_code directly enables display without additional mapping. Using a generic 'PESONET_VA' string would lose bank identity -> require second lookup to derive bank name at render time -> additional query complexity. initiateVaCheckout stores bankCode from formData as Transaction.paymentMethod at creation -> VA webhook path preserves the same bank_code value through to the CAPTURED state -> consistent bank_code throughout the payment lifecycle. |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Dynamic VA instead of Fixed VA | Dynamic VA requires amount correlation at route layer after webhook delivery; FVA binds one VA number to one external_id and enforces expected_amount — Xendit only fires payment webhook when full expected_amount received, eliminating amount reconciliation state from route layer. (ref: DL-001) |
| Transaction.metadata JSON for VA number storage | VA number is primary client-facing data; metadata is for audit trail — conflating forces JSON cast on every RSC render and produces an untyped field at query level; vaNumber as typed nullable column is directly SELECTable. (ref: DL-002) |
| useFormState stay-on-page checkout flow for VA | Server Action architecture does not support returning data to client without client-component conversion; redirect to order-detail is consistent with existing pattern and displays VA number on page that already renders it. (ref: DL-007) |
| xendit:invoice:PAID:{va-ext-id} key format for VA idempotency events | Contaminates idempotency_keys table with misleading product labels; xendit:va:PAID:{externalId} is clean and follows the documented provider:product:event:externalId format. (ref: DL-010) |
| Extend initiateCheckout with paymentMethod discriminator instead of separate action | Invoice and VA flows diverge at Xendit API call, idempotency guard, and Transaction shape; a discriminator branch makes both paths harder to read and test independently. (ref: DL-006) |
| New webhook auth verifier for VA webhook route | Xendit uses same x-callback-token mechanism for FVA callbacks as invoice callbacks; verifyXenditToken covers both; adding a duplicate verifier violates one-verifier-per-auth-mechanism structure with no functional benefit. (ref: DL-005) |

### Constraints

- handlers.ts changes limited to 2 one-liners — idempotency key construction uses payload.idempotencyKeyPrefix ?? 'xendit:invoice'
- No PaymentProvider interface or factory (YAGNI — T-14 DL-009)
- findUnique on @unique fields — never findFirst (Implementation Discipline)
- updateMany with status guard on every webhook state-transition write — never bare update (Implementation Discipline)
- redirect() after — never inside — try/catch blocks (Implementation Discipline)
- IdempotencyKey check+create inside same $transaction as business writes (Implementation Discipline)
- Null relation after explicit include must throw — never notFound() (Implementation Discipline)
- RSC DTOs serialize Decimal as string via .toFixed(2) and Date via .toISOString() (Implementation Discipline)
- Rollback test mock method names match handler Prisma call names exactly (Implementation Discipline)
- processPaymentCapture and processPaymentFailed must require zero changes to their business logic
- verifyXenditToken reused for VA webhook auth — same x-callback-token mechanism
- expected_amount set on FVA creation to match Transaction.amount — prevents partial-amount CAPTURED
- FVA expiration_date set to 72h from creation using Date arithmetic
- bank allowlist enforced server-side via isPesonetBankCode()
- amount threshold enforced at both UI and server (dual-layer boundary validation)
- vaNumber stored in Transaction.vaNumber String? — primary data vs audit data
- bank selection UI on order-detail page — payment-time decision, not order-creation decision

### Known Risks

- **Xendit FVA callback_virtual_account_id schema drift — Xendit renames the field, normalizeXenditVaPayload silently maps undefined to externalId, lookup fails.**: Validate field presence in route.ts before normalization and throw 400 with specific field-missing error.
- **Bank allowlist staleness — Xendit adds PESONet-eligible banks not in PESONET_BANK_CODES; legitimate banks rejected.**: Allowlist in domain/payments/pesonet.ts is a single-file update; server-side guard rejects unknown codes with informative error.
- **FVA collision — two concurrent initiateVaCheckout calls for same orderId create two PENDING Transactions and two FVAs.**: Idempotency guard in initiateVaCheckout checks for existing PENDING Transaction before Xendit call and returns error if found.
- **Orphaned VA — FVA created by Xendit but DB write fails; active FVA with no matching Transaction.**: FVA expires after 72h; EXPIRED webhook arrives as no-op (no Transaction found); Order remains PAYMENT_FAILED; client retries via existing retry CTA.
- **Amount threshold bypass — client removes UI gate and calls initiateVaCheckout for order below PESONET_MIN_AMOUNT.**: Server-side PESONET_MIN_AMOUNT guard in initiateVaCheckout throws before Xendit call regardless of UI state (dual-layer).
- **RSC boundary serialization crash — Transaction include added but vaNumber not added to OrderDetailDTO type; runtime crash on render.**: TypeScript strict mode catches missing DTO field at compile time if DTO type is explicitly declared with vaNumber: string | null.

## Invisible Knowledge

### System

PipetGo V2 payment layer uses a T-14 normalization boundary: route.ts is the sole provider-aware file per event type; handlers.ts accepts only NormalizedWebhookPayload and is provider-agnostic. The xendit-va route mirrors this boundary exactly — XenditVaPayload is confined to webhooks/xendit-va/types.ts, normalizeXenditVaPayload produces NormalizedWebhookPayload with idempotencyKeyPrefix set, and processPaymentCapture/processPaymentFailed are reused unchanged. The two-ID scheme (Transaction.id = our cuid, Transaction.externalId = Xendit returned ID) applies identically to VA: Transaction.externalId stores the Xendit FVA id from the creation response; the VA payment webhook delivers callback_virtual_account_id = that FVA id; normalizeXenditVaPayload maps it to NormalizedWebhookPayload.externalId for the findUnique lookup.

### Invariants

- Normalization boundary: route.ts (or xendit-va/route.ts) is the ONLY file that imports provider-specific types (XenditVaPayload). handlers.ts imports only NormalizedWebhookPayload from src/lib/payments/types.ts.
- Two-ID scheme: Transaction.id = our createId() cuid; Transaction.externalId = Xendit returned ID. For VA: externalId = Xendit FVA id (va.id from creation response). VA webhook callback_virtual_account_id = that FVA id. findUnique({ where: { externalId: callback_virtual_account_id } }) is the lookup.
- Idempotency create-last: IdempotencyKey row is created inside  AFTER all business writes succeed. A handler throw rolls back the key — Xendit retries land on an empty lookup and re-process correctly.
- RSC serialization: Prisma Decimal and Date objects cannot cross the RSC boundary. All DTO fields must be primitive types. vaNumber is String? (safe). Any transaction.createdAt passed to client must be .toISOString().
- updateMany status guard: every webhook state-transition write uses tx.model.updateMany({ where: { id, status: expectedPreState } }) and checks count === 0 for early return. Never bare update().
- findUnique on @unique fields: Transaction.externalId has @unique; lookup must use findUnique, never findFirst.

### Tradeoffs

- FVA over Dynamic VA (DL-001): FVA binds one VA number to one external_id for the VA lifetime and enforces expected_amount server-side at Xendit — Dynamic VA requires amount correlation logic at the route layer. Tradeoff: FVA is less flexible (one VA per order, cannot reuse for retries) but eliminates a reconciliation surface.
- Separate initiateVaCheckout over discriminator in initiateCheckout (DL-006): Invoice and VA flows diverge at step 3 (Xendit API), have different idempotency guards, and produce different Transaction shapes. Tradeoff: two actions to maintain vs. one action with branches; chosen because separate actions are independently testable and the divergence is fundamental, not incidental.
- idempotencyKeyPrefix in NormalizedWebhookPayload over xendit:invoice prefix reuse (DL-004): Using xendit:invoice:PAID:{va-ext-id} for VA events would be functionally correct (externalIds never collide) but semantically misleading in the idempotency_keys table. Tradeoff: requires two one-liner changes in handlers.ts vs. zero changes; chosen because clean product namespacing in the dedup table is worth the minimal handlers.ts touch.
- vaNumber String? column over Transaction.metadata (DL-002): VA number is primary client-facing data displayed on every order-detail render; metadata is an audit blob. Tradeoff: requires schema migration vs. no migration; chosen because a typed column serializes cleanly in RSC DTOs without JSON casting.

## Milestones

### Milestone 1: Schema migration — Transaction.vaNumber

**Files**: prisma/schema.prisma

**Requirements**:

- After applying the schema change, run: npx prisma migrate dev --name add-transaction-va-number

#### Code Intent

- **CI-M-001-001** `prisma/schema.prisma`: vaNumber String? field added to Transaction model after checkoutUrl field. Nullable so existing invoice-based rows are unaffected. Migration name: add-transaction-va-number. (refs: DL-002)

#### Code Changes

**CC-M-001-001** (prisma/schema.prisma) - implements CI-M-001-001

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -250,6 +250,7 @@ model Transaction {
   paymentMethod String?
   checkoutUrl   String?
+  vaNumber      String?
   failureReason String?

```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -250,6 +250,8 @@
   paymentMethod String?
   checkoutUrl   String?
+  // Xendit FVA account number displayed on order-detail. Typed nullable column (ref: DL-002):
+  // stored as primary data — not in metadata JSON — so RSC DTOs SELECT it without a cast.
   vaNumber      String?
   failureReason String?

```

> **Developer notes**: Schema change only. After this diff is applied, the developer must run `npx prisma migrate dev --name add-transaction-va-number` to generate the SQL migration file. Without this step the DB schema does not change and the vaNumber field is absent at runtime.

**CC-M-001-002** (prisma/schema.prisma) - implements CI-M-001-001

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -312,6 +312,8 @@ model IdempotencyKey {
 // Provider-agnostic dedup row. Key format: provider:product:event:externalId
 // e.g. xendit:invoice:PAID:{invoiceId}, xendit:invoice:EXPIRED:{invoiceId},
 // xendit:settlement:COMPLETED:{settlementId}.
+// xendit:va:PAID:{fvaId}, xendit:va:EXPIRED:{fvaId}.
 // processedAt is informational (no TTL — append-only at current scale).
 model IdempotencyKey {
@@ -242,6 +242,7 @@ model Transaction {
   paymentMethod String?
   checkoutUrl   String?
+  vaNumber      String?
   failureReason String?
   metadata      Json?
```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -312,6 +312,7 @@
 // Provider-agnostic dedup row. Key format: provider:product:event:externalId
 // e.g. xendit:invoice:PAID:{invoiceId}, xendit:invoice:EXPIRED:{invoiceId},
 // xendit:settlement:COMPLETED:{settlementId}.
+// xendit:va:PAID:{fvaId}, xendit:va:EXPIRED:{fvaId}.
 // processedAt is informational (no TTL — append-only at current scale).
 model IdempotencyKey {

```


### Milestone 2: PESONet domain constants

**Files**: src/domain/payments/pesonet.ts

**Acceptance Criteria**:

- PESONET_BANK_CODES ['BPI', 'BDO', 'RCBC', 'LANDBANK', 'UNIONBANK'] are M-confidence assumptions; the TODO comment in pesonet.ts makes this explicit. Sandbox bank-code verification is deferred to integration testing phase before go-live — wrong codes cause HTTP 400 on createXenditVa making VA payments impossible. No change to code required; TODO is the documented risk acknowledgment.

#### Code Intent

- **CI-M-002-001** `src/domain/payments/pesonet.ts`: Exports PESONET_MIN_AMOUNT = 50_000 (number), PESONET_BANK_CODES as const tuple of Xendit-eligible PESONet bank codes (BPI, BDO, RCBC, LANDBANK, UNIONBANK), PesonetBankCode type alias, and isPesonetBankCode(value: unknown) type guard returning value is PesonetBankCode. (refs: DL-009)

#### Code Changes

**CC-M-002-001** (src/domain/payments/pesonet.ts) - implements CI-M-002-001

**Code:**

```diff
--- /dev/null
+++ b/src/domain/payments/pesonet.ts
@@ -0,0 +1,25 @@
+/**
+ * PESONet domain constants — business rules for PESONet VA payments.
+ *
+ * Bank allowlist and threshold are business rules, not UI concerns.
+ * Domain location prevents arbitrary bank_code injection through checkout action.
+ * Imported by both checkout action (server validation) and order-detail page (UI gate)
+ * without ADR-001 violations. (ref: DL-009)
+ */
+
+/** Minimum order amount in PHP required for PESONet VA payment option. */
+export const PESONET_MIN_AMOUNT = 50_000
+
+/**
+ * Allowed Xendit PESONet-eligible FVA bank codes.
+ *
+ * TODO: Verify these codes against Xendit FVA documentation before go-live.
+ * Wrong bank codes cause createXenditVa to return HTTP 400.
+ * Reference: https://developers.xendit.co/api-reference/#create-fixed-virtual-account
+ */
+export const PESONET_BANK_CODES = ['BPI', 'BDO', 'RCBC', 'LANDBANK', 'UNIONBANK'] as const
+
+export type PesonetBankCode = (typeof PESONET_BANK_CODES)[number]
+
+/** Type guard — returns true if value is a valid PesonetBankCode. */
+export function isPesonetBankCode(value: unknown): value is PesonetBankCode {
+  return typeof value === 'string' && (PESONET_BANK_CODES as readonly string[]).includes(value)
+}

```

**Documentation:**

```diff
--- a/src/domain/payments/pesonet.ts
+++ b/src/domain/payments/pesonet.ts
@@ -0,0 +1,25 @@
+/**
+ * PESONet domain constants — business rules for PESONet VA payments.
+ *
+ * Bank allowlist and threshold are business rules, not UI concerns. (ref: DL-009)
+ * Domain location prevents arbitrary bank_code injection through checkout action.
+ * Imported by both checkout action (server validation) and order-detail page (UI gate)
+ * without ADR-001 violations.
+ */
+
+/** Minimum order amount in PHP for PESONet VA eligibility. (ref: DL-008) */
+export const PESONET_MIN_AMOUNT = 50_000
+
+/**
+ * Xendit PESONet-eligible FVA bank codes.
+ *
+ * Server-side allowlist — enforced in initiateVaCheckout via isPesonetBankCode().
+ * Unknown codes cause Xendit to return HTTP 400.
+ * Verify against Xendit docs before adding entries. (ref: R-002)
+ */
+export const PESONET_BANK_CODES = ['BPI', 'BDO', 'RCBC', 'LANDBANK', 'UNIONBANK'] as const
+
+export type PesonetBankCode = (typeof PESONET_BANK_CODES)[number]
+
+/** Returns true when code is a Xendit PESONet-eligible bank code. (ref: DL-009) */
+export function isPesonetBankCode(code: string): code is PesonetBankCode {
+  return (PESONET_BANK_CODES as readonly string[]).includes(code)
+}

```


**CC-M-002-002** (src/domain/payments/pesonet.ts) - implements CI-M-002-001

**Code:**

```diff
--- /dev/null
+++ b/src/domain/payments/pesonet.ts
@@ -0,0 +1,30 @@
+/**
+ * PESONet domain constants.
+ *
+ * PESONET_MIN_AMOUNT enforces the PHP 50,000 floor at domain level;
+ * both UI and server action validate against this constant.
+ * isPesonetBankCode enforces the server-side bank allowlist.
+ */
+
+export const PESONET_MIN_AMOUNT = 50_000
+
+export const PESONET_BANK_CODES = [
+  'BPI',
+  'BDO',
+  'RCBC',
+  'LANDBANK',
+  'UNIONBANK',
+] as const
+
+export type PesonetBankCode = (typeof PESONET_BANK_CODES)[number]
+
+/**
+ * Returns true when code is one of the Xendit PESONet-eligible bank codes.
+ * Used server-side in initiateVaCheckout to enforce the bank allowlist.
+ */
+export function isPesonetBankCode(code: string): code is PesonetBankCode {
+  return (PESONET_BANK_CODES as readonly string[]).includes(code)
+}
+
+export const PESONET_BANK_LABELS: Record<PesonetBankCode, string> = {
+  BPI: 'Bank of the Philippine Islands',
+  BDO: 'Banco de Oro',
+  RCBC: 'Rizal Commercial Banking Corporation',
+  LANDBANK: 'Land Bank of the Philippines',
+  UNIONBANK: 'UnionBank of the Philippines',
+}
```

**Documentation:**

```diff
--- a/src/domain/payments/pesonet.ts
+++ b/src/domain/payments/pesonet.ts
@@ -0,0 +1,30 @@
+/**
+ * PESONet domain constants.
+ *
+ * PESONET_MIN_AMOUNT enforces the PHP 50,000 floor at domain level;
+ * both UI and server action validate against this constant. (ref: DL-008, DL-009)
+ * isPesonetBankCode enforces the server-side bank allowlist.
+ */
+
+/** Minimum order amount in PHP for PESONet VA eligibility. */
+export const PESONET_MIN_AMOUNT = 50_000
+
+/**
+ * Xendit PESONet-eligible FVA bank codes. (ref: DL-009, R-002)
+ *
+ * Unknown bank codes cause Xendit to return HTTP 400.
+ * Verify against Xendit FVA docs before adding entries.
+ */
+export const PESONET_BANK_CODES = [
+  'BPI',
+  'BDO',
+  'RCBC',
+  'LANDBANK',
+  'UNIONBANK',
+] as const
+
+export type PesonetBankCode = (typeof PESONET_BANK_CODES)[number]
+
+/** Returns true when code is a Xendit PESONet-eligible bank code. Server-side guard in initiateVaCheckout. */
+export function isPesonetBankCode(code: string): code is PesonetBankCode {
+  return (PESONET_BANK_CODES as readonly string[]).includes(code)
+}

```


### Milestone 3: NormalizedWebhookPayload extension + handlers.ts key-prefix one-liners

**Files**: src/lib/payments/types.ts, src/features/payments/webhooks/handlers.ts

**Acceptance Criteria**:

- NormalizedWebhookPayload type in src/lib/payments/types.ts gains idempotencyKeyPrefix?: string field; existing externalId and paymentMethod fields unchanged
- handlers.ts processPaymentCapture: idempotency key line uses payload.idempotencyKeyPrefix ?? 'xendit:invoice' — exactly one line changed
- handlers.ts processPaymentFailed: idempotency key line uses payload.idempotencyKeyPrefix ?? 'xendit:invoice' — exactly one line changed
- src/features/payments/webhooks/route.ts is NOT modified — regression boundary: invoice route continues to work without changes
- npx tsc --noEmit clean after M-003 changes

#### Code Intent

- **CI-M-003-001** `src/lib/payments/types.ts`: NormalizedWebhookPayload gains optional idempotencyKeyPrefix string field. All existing consumers (invoice route, invoice handlers) remain backward-compatible via absence of the field. (refs: DL-004)
- **CI-M-003-002** `src/features/payments/webhooks/handlers.ts`: processPaymentCapture idempotency key construction changes from literal 'xendit:invoice:PAID:{externalId}' to template using payload.idempotencyKeyPrefix ?? 'xendit:invoice'. processPaymentFailed same change for EXPIRED key. Two one-liner changes only; all business logic, state-machine guards, and atomic write patterns are unchanged. Regression boundary: when invoice route.ts passes NormalizedWebhookPayload without idempotencyKeyPrefix (absent field), ?? 'xendit:invoice' produces the same key string as the pre-T-17 literal — backward compatible by construction. Verified by the existing invoice handler integration test suite (handlers.test.ts) running without modification and confirming invoice PAID and EXPIRED key formats are unchanged after the one-liner edit. (refs: DL-004, DL-010)

#### Code Changes

**CC-M-003-001** (src/lib/payments/types.ts) - implements CI-M-003-001

**Code:**

```diff
--- a/src/lib/payments/types.ts
+++ b/src/lib/payments/types.ts
@@ -16,4 +16,6 @@ export interface NormalizedWebhookPayload {
   externalId: string
   paymentMethod?: string
+  idempotencyKeyPrefix?: string
+  failureReason?: string
 }

```

**Documentation:**

```diff
--- a/src/lib/payments/types.ts
+++ b/src/lib/payments/types.ts
@@ -16,6 +16,14 @@
 export interface NormalizedWebhookPayload {
   externalId: string
   paymentMethod?: string
+  /**
+   * Idempotency key prefix for handlers; determines key namespace in idempotency_keys.
+   * Format: provider:product — e.g. 'xendit:va', 'xendit:invoice'. (ref: DL-004, DL-010)
+   * Defaults to 'xendit:invoice' in handlers when absent for rolling-deploy safety.
+   */
+  idempotencyKeyPrefix?: string
+  /**
+   * Provider-reported failure reason; written to Transaction.failureReason on EXPIRED/FAILED events.
+   */
+  failureReason?: string
 }

```


**CC-M-003-002** (src/features/payments/webhooks/handlers.ts) - implements CI-M-003-002

**Code:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -29,7 +29,7 @@ export async function processPaymentCapture(payload: NormalizedWebhookPayload): Promise<void> {
   await prisma.$transaction(async (tx) => {
-    // xendit: prefix format is deployed; changing it requires migrating idempotency_keys rows. (ref: DL-005)
-    const idempotencyKey = `xendit:invoice:PAID:${payload.externalId}`
+    // 'xendit:invoice' fallback is deploy-safety: absent prefix during rolling deploy preserves pre-T-17 key format. (ref: T-17 DL-004)
+    const idempotencyKey = `${payload.idempotencyKeyPrefix ?? 'xendit:invoice'}:PAID:${payload.externalId}`
     const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })

@@ -103,7 +103,7 @@ export async function processPaymentFailed(payload: NormalizedWebhookPayload): Promise<void> {
   await prisma.$transaction(async (tx) => {
-    // xendit: prefix format is deployed; changing it requires migrating idempotency_keys rows. (ref: DL-005)
-    const idempotencyKey = `xendit:invoice:EXPIRED:${payload.externalId}`
+    // 'xendit:invoice' fallback is deploy-safety: absent prefix during rolling deploy preserves pre-T-17 key format. (ref: T-17 DL-004)
+    const idempotencyKey = `${payload.idempotencyKeyPrefix ?? 'xendit:invoice'}:EXPIRED:${payload.externalId}`
     const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })

@@ -137,7 +137,7 @@ export async function processPaymentFailed(payload: NormalizedWebhookPayload): Promise<void> {
     const failResult = await tx.transaction.updateMany({
       where: { id: transaction.id, status: transaction.status },
       data: {
         status: TransactionStatus.FAILED,
-        failureReason: 'Xendit invoice EXPIRED',
+        failureReason: payload.failureReason ?? 'Xendit invoice EXPIRED',
       },
     })

```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -29,7 +29,9 @@
   await prisma.$transaction(async (tx) => {
-    // xendit: prefix format is deployed; changing it requires migrating idempotency_keys rows. (ref: DL-005)
-    const idempotencyKey = 
+    // Backward-compatible fallback for routes sending no idempotencyKeyPrefix:
+    // ?? 'xendit:invoice' preserves the existing key format during rolling deploys.
+    // WARNING: changing either the prefix or the key format requires migrating
+    // existing idempotency_keys rows — orphaned keys enable double-processing. (ref: DL-004)
+    const idempotencyKey = 
     const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })

```


**CC-M-003-003** (src/lib/payments/types.ts) - implements CI-M-003-001

**Code:**

```diff
--- a/src/lib/payments/types.ts
+++ b/src/lib/payments/types.ts
@@ -16,4 +16,9 @@ export interface NormalizedWebhookPayload {
 export interface NormalizedWebhookPayload {
   externalId: string
   paymentMethod?: string
+  /**
+   * Idempotency key prefix for handlers (e.g. 'xendit:va', 'xendit:invoice').
+   * Defaults to 'xendit:invoice' when absent for backward compatibility.
+   */
+  idempotencyKeyPrefix?: string
 }
```

**Documentation:**

```diff
--- a/src/lib/payments/types.ts
+++ b/src/lib/payments/types.ts
@@ -16,6 +16,11 @@
 export interface NormalizedWebhookPayload {
   externalId: string
   paymentMethod?: string
+  /**
+   * Idempotency key prefix for handlers (e.g. 'xendit:va', 'xendit:invoice').
+   * Defaults to 'xendit:invoice' when absent for backward compatibility. (ref: DL-004)
+   * Set explicitly by each webhook route.ts.
+   */
+  idempotencyKeyPrefix?: string
 }

```


**CC-M-003-004** (src/features/payments/webhooks/handlers.ts) - implements CI-M-003-002

**Code:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -30,7 +30,7 @@ export async function processPaymentCapture(payload: NormalizedWebhookPayload): Promise<void> {
   await prisma.$transaction(async (tx) => {
-    // xendit: prefix format is deployed; changing it requires migrating idempotency_keys rows. (ref: DL-005)
-    const idempotencyKey = `xendit:invoice:PAID:${payload.externalId}`
+    const idempotencyKey = `${payload.idempotencyKeyPrefix ?? 'xendit:invoice'}:PAID:${payload.externalId}`
     const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
@@ -104,7 +104,7 @@ export async function processPaymentFailed(payload: NormalizedWebhookPayload): Promise<void> {
   await prisma.$transaction(async (tx) => {
-    // xendit: prefix format is deployed; changing it requires migrating idempotency_keys rows. (ref: DL-005)
-    const idempotencyKey = `xendit:invoice:EXPIRED:${payload.externalId}`
+    const idempotencyKey = `${payload.idempotencyKeyPrefix ?? 'xendit:invoice'}:EXPIRED:${payload.externalId}`
     const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -30,7 +30,8 @@
   await prisma.$transaction(async (tx) => {
-    const idempotencyKey = `xendit:invoice:PAID:${payload.externalId}`
+    // ?? fallback: deploy-safety for rolling deploys where old route sends no prefix. (ref: DL-004)
+    const idempotencyKey = `${payload.idempotencyKeyPrefix ?? 'xendit:invoice'}:PAID:${payload.externalId}`
     const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })

```


**CC-M-003-005** (src/features/payments/webhooks/README.md)

**Documentation:**

```diff
--- a/src/features/payments/webhooks/README.md
+++ b/src/features/payments/webhooks/README.md
@@ -93,8 +93,14 @@
 ## Invariants
 
-- Idempotency guard (IdempotencyKey layer + Transaction.status layer) is inside `$transaction` to
-  prevent race conditions from concurrent Xendit deliveries. (ref: DL-004)
-- `PaymentCapturedEvent.amount` comes from `Transaction.amount` (Prisma `Decimal`),
-  not `payload.paid_amount` (float). (ref: DL-005)
-- Order status transitions are owned by the orders slice — this handler never
-  writes `Order.status` directly. (ref: DL-001)
-- Webhook capture writes only `Transaction.status` and (via fan-out) `Order.status`;
-  commission settlement is tracked via Payout records created at order completion,
-  not at payment capture. (ref: DL-016)
-- `webhooks/handlers.ts` imports zero provider-specific types; only `route.ts`
-  references `XenditInvoicePayload`.
+- Idempotency guard (IdempotencyKey layer + Transaction.status layer) is inside `$transaction` to
+  prevent race conditions from concurrent Xendit deliveries. (ref: DL-004)
+- `PaymentCapturedEvent.amount` comes from `Transaction.amount` (Prisma `Decimal`),
+  not `payload.paid_amount` (float). (ref: DL-005)
+- Order status transitions are owned by the orders slice — this handler never
+  writes `Order.status` directly. (ref: DL-001)
+- Webhook capture writes only `Transaction.status` and (via fan-out) `Order.status`;
+  commission settlement is tracked via Payout records created at order completion,
+  not at payment capture. (ref: DL-016)
+- `webhooks/handlers.ts` imports zero provider-specific types; only the respective
+  `route.ts` files reference provider-specific payload shapes.
+- `idempotencyKeyPrefix` in `NormalizedWebhookPayload` determines the key namespace:
+  `xendit:invoice` for invoice events, `xendit:va` for FVA events. The `??` fallback
+  in handlers preserves backward-compatible key format for routes that omit the field. (ref: DL-004)
 
 ## Design decisions
 
 **AD-001 Direct Payment**: Under the AD-001 model, the client pays the lab directly
 via Xendit Managed Sub-Account. The webhook handler's job is solely to advance
 Transaction and Order state. Commission tracking moves to `Payout` records created
-inside `completeOrder` — see `src/features/orders/lab-fulfillment/` and
+inside `completeOrder` — see `src/features/orders/lab-fulfillment/` and
 `docs/roadmap.md` AD-001 section.
 
 **Provider normalization boundary**: Normalization happens at the route boundary —
-`route.ts` parses `XenditInvoicePayload` and calls `normalizeXenditInvoicePayload`
-(in `webhooks/types.ts`) to produce `NormalizedWebhookPayload` before invoking
-handlers. This means a future provider migration (e.g., PayMongo) only requires
-adding `src/lib/payments/paymongo.ts` plus `src/features/payments/webhooks/paymongo/route.ts`
-— zero edits to `handlers.ts` or `src/domain`. Forward-compat stubs
-`verifyPayMongoHmac` and `verifyHitPayHmac` are already present in
-`src/lib/payments/webhook-auth.ts`.
+each `route.ts` file normalizes its provider-specific payload to `NormalizedWebhookPayload`
+before invoking handlers. The `xendit-va/` sub-slice follows the same pattern as the
+invoice route — a future provider migration only requires adding a new route file and
+types adapter. Zero edits to `handlers.ts` or `src/domain`. Forward-compat stubs
+`verifyPayMongoHmac` and `verifyHitPayHmac` are already present in `webhook-auth.ts`.
+
+**PESONet VA sub-slice**: `webhooks/xendit-va/` handles Xendit FVA payment callbacks.
+See `webhooks/xendit-va/README.md` for the full VA request flow, two-ID scheme, and
+FVA constraints.

```


### Milestone 4: Xendit VA client

**Files**: src/lib/payments/xendit-va.ts

#### Code Intent

- **CI-M-004-001** `src/lib/payments/xendit-va.ts`: Exports XenditVaParams type, XenditVaResult type, XenditVaError class (extends Error with status and body), and createXenditVa async function. createXenditVa POSTs to https://api.xendit.co/fixed-virtual-accounts with Basic Auth using XENDIT_SECRET_KEY, body includes external_id, bank_code, name, expected_amount, is_closed: true, expiration_date as ISO string. Returns XenditVaResult { vaId: raw.id, accountNumber: raw.account_number, bankCode: raw.bank_code, externalId: raw.external_id, rawResponse }. Throws XenditVaError(500) when XENDIT_SECRET_KEY absent; throws XenditVaError(status, body) on non-2xx. (refs: DL-001, DL-003, DL-012, DL-016, DL-017, DL-018)

#### Code Changes

**CC-M-004-001** (src/lib/payments/xendit-va.ts) - implements CI-M-004-001

**Code:**

```diff
--- /dev/null
+++ b/src/lib/payments/xendit-va.ts
@@ -0,0 +1,72 @@
+/**
+ * Xendit Fixed Virtual Account (FVA) integration — infrastructure layer.
+ *
+ * Must not import from @/features/ or @/domain/; this is infrastructure.
+ */
+
+/** Parameters sent to the Xendit FVA API to create a fixed virtual account. */
+export type XenditVaParams = {
+  externalId: string
+  bankCode: string
+  name: string
+  expectedAmount: number
+  expirationDate: Date
+}
+
+/**
+ * Normalized result from a successful Xendit FVA creation.
+ *
+ * vaId          — Xendit's FVA ID; stored in Transaction.externalId (ref: DL-017).
+ * accountNumber — VA account number displayed to client; stored in Transaction.vaNumber.
+ * bankCode      — Bank code; stored in Transaction.paymentMethod.
+ * externalId    — Our transactionId cuid returned for correlation.
+ * rawResponse   — Full Xendit response body for audit.
+ */
+export type XenditVaResult = {
+  vaId: string
+  accountNumber: string
+  bankCode: string
+  externalId: string
+  rawResponse: Record<string, unknown>
+}
+
+/** Thrown when the Xendit FVA API returns a non-2xx response or config is missing. */
+export class XenditVaError extends Error {
+  constructor(
+    public readonly status: number,
+    public readonly body: unknown,
+    message?: string,
+  ) {
+    super(message ?? `Xendit VA API error: ${status}`)
+    this.name = 'XenditVaError'
+  }
+}
+
+/**
+ * Creates a Xendit Fixed Virtual Account for PESONet payment.
+ *
+ * is_closed: true enforces single-payment binding — VA closes after first full payment. (ref: DL-016)
+ * expected_amount enforced by Xendit: webhook only fires when full amount received. (ref: DL-003)
+ * Xendit call precedes DB write: orphaned FVAs expire in 72h; missing DB records are not recoverable. (ref: DL-015)
+ */
+export async function createXenditVa(params: XenditVaParams): Promise<XenditVaResult> {
+  const secretKey = process.env.XENDIT_SECRET_KEY
+  if (!secretKey) {
+    throw new XenditVaError(500, null, 'XENDIT_SECRET_KEY is not set')
+  }
+
+  const credentials = Buffer.from(`${secretKey}:`).toString('base64')
+
+  const response = await fetch('https://api.xendit.co/fixed-virtual-accounts', {
+    method: 'POST',
+    headers: {
+      'Content-Type': 'application/json',
+      Authorization: `Basic ${credentials}`,
+    },
+    body: JSON.stringify({
+      external_id: params.externalId,
+      bank_code: params.bankCode,
+      name: params.name,
+      expected_amount: params.expectedAmount,
+      is_closed: true,
+      expiration_date: params.expirationDate.toISOString(),
+    }),
+  })
+
+  if (!response.ok) {
+    const errorBody = await response.text()
+    throw new XenditVaError(response.status, errorBody)
+  }
+
+  const raw = (await response.json()) as Record<string, unknown>
+
+  return {
+    vaId: raw['id'] as string,
+    accountNumber: raw['account_number'] as string,
+    bankCode: raw['bank_code'] as string,
+    externalId: raw['external_id'] as string,
+    rawResponse: raw,
+  }
+}

```

**Documentation:**

```diff
--- a/src/lib/payments/xendit-va.ts
+++ b/src/lib/payments/xendit-va.ts
@@ -0,0 +1,72 @@
+/**
+ * Xendit Fixed Virtual Account (FVA) client — infrastructure layer.
+ *
+ * POST /callback_virtual_accounts creates a bank-specific FVA tied to one
+ * external_id. expected_amount prevents partial-amount CAPTURED events;
+ * is_closed: true prevents double-credit from a second bank transfer. (ref: DL-001, DL-016)
+ *
+ * Must not import from @/features/ or @/domain/.
+ */
+
+/** Parameters for Xendit FVA creation. */
+export type XenditVaParams = {
+  externalId: string   // Our transactionId cuid — stored as Xendit's external_id (ref: DL-017)
+  bankCode: string     // PESONet bank code — validated server-side before call (ref: DL-009)
+  name: string         // Client display name on the VA
+  expectedAmount: number  // Transaction.amount.toNumber() — Xendit requires JSON number (ref: DL-018)
+  expirationDate: Date // 72h from creation via Date arithmetic; no date-fns dependency (ref: DL-012)
+}
+
+/**
+ * Result from a successful Xendit FVA creation.
+ *
+ * vaId          — Xendit's FVA ID; stored in Transaction.externalId. (ref: DL-017)
+ *                 VA webhook delivers callback_virtual_account_id = this value.
+ * accountNumber — VA account number shown to client; stored in Transaction.vaNumber. (ref: DL-002)
+ * bankCode      — Echo of the requested bank; stored in Transaction.paymentMethod. (ref: DL-020)
+ */
+export type XenditVaResult = {
+  vaId: string
+  accountNumber: string
+  bankCode: string
+  externalId: string
+}
+
+/** Thrown when the Xendit FVA API returns a non-OK status. */
+export class XenditVaError extends Error {
+  constructor(
+    public status: number,
+    message: string,
+  ) {
+    super(message)
+    this.name = 'XenditVaError'
+  }
+}
+
+/**
+ * Creates a Xendit Fixed Virtual Account via POST /callback_virtual_accounts.
+ *
+ * is_closed: true enforces single-payment binding — prevents double-credit from
+ * a second bank transfer after the first CAPTURED webhook. (ref: DL-016)
+ *
+ * expected_amount is set to Transaction.amount so Xendit only fires the payment
+ * webhook when the full amount is received — eliminates partial-amount CAPTURED. (ref: DL-003)
+ *
+ * Throws XenditVaError on non-2xx Xendit response.
+ */
+export async function createXenditVa(params: XenditVaParams): Promise<XenditVaResult> {

```


**CC-M-004-002** (src/lib/payments/xendit-va.ts) - implements CI-M-004-001

**Code:**

```diff
--- /dev/null
+++ b/src/lib/payments/xendit-va.ts
@@ -0,0 +1,90 @@
+/**
+ * Xendit Fixed Virtual Account (FVA) client — infrastructure layer.
+ *
+ * Provides a typed interface to the Xendit Fixed Virtual Account API
+ * (POST /callback_virtual_accounts). Creates a bank-specific FVA tied to one
+ * external_id with an expected_amount to prevent partial-amount CAPTURED.
+ *
+ * Must not import from @/features/ or @/domain/; this is infrastructure.
+ */
+
+import { XenditApiError } from './xendit'
+
+export type { XenditApiError }
+
+/** Parameters for Xendit FVA creation. */
+export type XenditVaParams = {
+  externalId: string
+  bankCode: string
+  name: string
+  expectedAmount: number
+  expirationDate: string
+}
+
+/**
+ * Normalised result from a successful Xendit FVA creation.
+ *
+ * fvaId           — Xendit FVA ID stored in Transaction.externalId.
+ * accountNumber   — VA number displayed to the client for bank transfer.
+ * rawResponse     — Full Xendit response body stored in Transaction.metadata.
+ */
+export type XenditVaResult = {
+  fvaId: string
+  accountNumber: string
+  rawResponse: Record<string, unknown>
+}
+
+/**
+ * Creates a Xendit Fixed Virtual Account and returns the FVA details.
+ *
+ * Sequence:
+ *   1. Reads XENDIT_SECRET_KEY from env — throws XenditApiError(500) if absent.
+ *   2. POST /callback_virtual_accounts with Basic Auth.
+ *   3. Returns fvaId (stored in Transaction.externalId), accountNumber
+ *      (stored in Transaction.vaNumber and displayed to client), and rawResponse.
+ *
+ * expected_amount is set to prevent partial-amount CAPTURED events.
+ * expiration_date is set to 72 hours from creation.
+ *
+ * Call ordering: call this function BEFORE the Prisma Transaction.create write,
+ * mirroring the invoice flow (ref: DL-002).
+ *
+ * Currency is always PHP.
+ */
+export async function createXenditVa(
+  params: XenditVaParams,
+): Promise<XenditVaResult> {
+  const secretKey = process.env.XENDIT_SECRET_KEY
+  if (!secretKey) {
+    throw new XenditApiError('XENDIT_SECRET_KEY is not set', 500, null)
+  }
+
+  const credentials = Buffer.from(`${secretKey}:`).toString('base64')
+
+  const response = await fetch('https://api.xendit.co/callback_virtual_accounts', {
+    method: 'POST',
+    headers: {
+      'Content-Type': 'application/json',
+      Authorization: `Basic ${credentials}`,
+    },
+    body: JSON.stringify({
+      external_id: params.externalId,
+      bank_code: params.bankCode,
+      name: params.name,
+      expected_amount: params.expectedAmount,
+      expiration_date: params.expirationDate,
+      is_closed: true,
+      is_single_use: true,
+    }),
+  })
+
+  if (!response.ok) {
+    const errorBody = await response.text()
+    throw new XenditApiError(
+      `Xendit VA API error: ${response.status}`,
+      response.status,
+      errorBody,
+    )
+  }
+
+  const raw = (await response.json()) as Record<string, unknown>
+
+  return {
+    fvaId: raw['id'] as string,
+    accountNumber: raw['account_number'] as string,
+    rawResponse: raw,
+  }
+}
```

**Documentation:**

```diff
--- a/src/lib/payments/xendit-va.ts
+++ b/src/lib/payments/xendit-va.ts
@@ -0,0 +1,90 @@
+/**
+ * Xendit Fixed Virtual Account (FVA) client — infrastructure layer.
+ *
+ * POST /callback_virtual_accounts creates a bank-specific FVA tied to one
+ * external_id with an expected_amount to prevent partial-amount CAPTURED.
+ * is_closed: true enforces single-payment binding. (ref: DL-001, DL-003, DL-016)
+ *
+ * Must not import from @/features/ or @/domain/.
+ */
+
+/** Parameters for Xendit FVA creation. */
+export type XenditVaParams = {
+  externalId: string       // Our transactionId cuid (ref: DL-017)
+  bankCode: string         // PESONet-eligible bank code (ref: DL-009)
+  name: string             // Client display name
+  expectedAmount: number   // Transaction.amount.toNumber() — Xendit requires number, not string (ref: DL-018)
+  expirationDate: string   // ISO-8601; 72h from creation (ref: DL-012)
+}
+
+/**
+ * Normalized result from a successful Xendit FVA creation.
+ *
+ * vaId          — Xendit's FVA ID; stored as Transaction.externalId. (ref: DL-017)
+ * accountNumber — VA number displayed to client; stored as Transaction.vaNumber. (ref: DL-002)
+ * bankCode      — Echo of the requested bank; stored as Transaction.paymentMethod. (ref: DL-020)
+ */
+export type XenditVaResult = {
+  vaId: string
+  accountNumber: string
+  bankCode: string
+  externalId: string
+}
+
+/**
+ * Creates a Xendit FVA. Throws XenditApiError on non-2xx response.
+ *
+ * is_closed: true — VA accepts exactly one deposit matching expected_amount,
+ * then auto-closes; prevents a second bank transfer firing a double-credit
+ * payment webhook. (ref: DL-016)
+ */
+export async function createXenditVa(params: XenditVaParams): Promise<XenditVaResult> {

```


### Milestone 5: VA webhook types and normalizer

**Files**: src/features/payments/webhooks/xendit-va/types.ts

#### Code Intent

- **CI-M-005-001** `src/features/payments/webhooks/xendit-va/types.ts`: Exports XenditVaPayload interface with callback_virtual_account_id, external_id, bank_code, amount, status, account_number, optional payment_id fields. Exports normalizeXenditVaPayload(raw: XenditVaPayload): NormalizedWebhookPayload. Normalizer maps callback_virtual_account_id to externalId (not external_id which is our cuid), bank_code to paymentMethod, sets idempotencyKeyPrefix to xendit:va. Throws Error with message containing missing required callback_virtual_account_id when field is null, empty, whitespace-only, or non-string. (refs: DL-010, DL-011, DL-020)

#### Code Changes

**CC-M-005-001** (src/features/payments/webhooks/xendit-va/types.ts) - implements CI-M-005-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/xendit-va/types.ts
@@ -0,0 +1,44 @@
+/**
+ * Xendit FVA payment webhook types.
+ *
+ * XenditVaPayload is the raw shape of the Xendit FVA payment callback body.
+ * xendit-va/route.ts normalizes to NormalizedWebhookPayload before dispatching.
+ * handlers.ts never imports this type. (ref: DL-013)
+ */
+import type { NormalizedWebhookPayload } from '@/lib/payments/types'
+
+export interface XenditVaPayload {
+  callback_virtual_account_id: string
+  external_id: string
+  bank_code?: string
+  status: string
+  amount?: number
+}
+
+/**
+ * Xendit FVA adapter.
+ *
+ * callback_virtual_account_id maps to externalId — Xendit FVA ID stored in
+ * Transaction.externalId at creation time; webhook lookup uses this ID. (ref: DL-011)
+ * bank_code maps to paymentMethod — granular bank identity for display and reconciliation. (ref: DL-020)
+ * idempotencyKeyPrefix: 'xendit:va' isolates VA events from invoice events in idempotency_keys. (ref: DL-010)
+ * failureReason is set per-status so processPaymentFailed writes 'Xendit VA EXPIRED' or
+ * 'Xendit VA FAILED' instead of the invoice-specific fallback string in handlers.ts. (ref: qa-007)
+ */
+
+const VA_FAILURE_REASON: Record<string, string> = {
+  EXPIRED: 'Xendit VA EXPIRED',
+  FAILED: 'Xendit VA FAILED',
+}
+
+export function normalizeXenditVaPayload(raw: XenditVaPayload): NormalizedWebhookPayload {
+  if (typeof raw.callback_virtual_account_id !== 'string' || raw.callback_virtual_account_id.trim() === '') {
+    throw new Error('Xendit VA payload missing required callback_virtual_account_id field')
+  }
+  const status = (raw.status ?? '').toUpperCase()
+  return {
+    externalId: raw.callback_virtual_account_id,
+    paymentMethod: raw.bank_code,
+    idempotencyKeyPrefix: 'xendit:va',
+    failureReason: VA_FAILURE_REASON[status],
+  }
+}

```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/xendit-va/types.ts
+++ b/src/features/payments/webhooks/xendit-va/types.ts
@@ -0,0 +1,44 @@
+/**
+ * Xendit FVA payment webhook types.
+ *
+ * XenditVaPayload is the raw shape of the Xendit FVA callback body.
+ * route.ts casts to this type, then calls normalizeXenditVaPayload before
+ * dispatching to handlers. handlers.ts never imports this type. (ref: DL-013)
+ */
+import type { NormalizedWebhookPayload } from '@/lib/payments/types'
+
+export interface XenditVaPayload {
+  callback_virtual_account_id: string  // Xendit FVA ID — lookup key (ref: DL-011)
+  external_id: string                  // Our transactionId cuid (ref: DL-017)
+  bank_code?: string                   // Bank code; stored as Transaction.paymentMethod (ref: DL-020)
+  status: string                       // COMPLETED | EXPIRED | FAILED | PENDING | ACTIVE
+  amount?: number
+}
+
+/**
+ * Normalizes a Xendit FVA callback to NormalizedWebhookPayload.
+ *
+ * callback_virtual_account_id -> externalId: this is the Xendit FVA ID stored in
+ * Transaction.externalId at creation time. The webhook lookup uses this ID, not
+ * payload.external_id (which is our cuid). (ref: DL-011)
+ *
+ * idempotencyKeyPrefix: 'xendit:va' — keys: xendit:va:PAID:{fvaId},
+ * xendit:va:EXPIRED:{fvaId}. Avoids xendit:invoice namespace collision. (ref: DL-010)
+ *
+ * bank_code -> paymentMethod: preserves granular bank identity for display and
+ * reconciliation without requiring a second lookup at render time. (ref: DL-020)
+ */
+export function normalizeXenditVaPayload(raw: XenditVaPayload): NormalizedWebhookPayload {

```


**CC-M-005-002** (src/features/payments/webhooks/xendit-va/types.ts) - implements CI-M-005-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/xendit-va/types.ts
@@ -0,0 +1,38 @@
+/**
+ * Xendit Fixed Virtual Account webhook types.
+ *
+ * XenditVaPayload is the raw shape of the Xendit FVA payment callback body.
+ * route.ts parses and casts to this type, then normalizes to NormalizedWebhookPayload
+ * before dispatching to handlers. handlers.ts never imports this type.
+ */
+import type { NormalizedWebhookPayload } from '@/lib/payments/types'
+
+export interface XenditVaPayload {
+  callback_virtual_account_id: string
+  status: string
+  payment_method?: string
+}
+
+/**
+ * Xendit FVA-specific adapter. Maps callback_virtual_account_id -> externalId
+ * (the FVA ID Xendit returned at creation, stored in Transaction.externalId).
+ *
+ * Sets idempotencyKeyPrefix to 'xendit:va' so handlers construct
+ * xendit:va:PAID:{fvaId} and xendit:va:EXPIRED:{fvaId} keys.
+ *
+ * Throws when callback_virtual_account_id is null, empty, or non-string so
+ * malformed payloads are rejected at the route boundary with a 400.
+ */
+export function normalizeXenditVaPayload(raw: XenditVaPayload): NormalizedWebhookPayload {
+  if (
+    typeof raw.callback_virtual_account_id !== 'string' ||
+    raw.callback_virtual_account_id.trim() === ''
+  ) {
+    throw new Error('Xendit VA payload missing required callback_virtual_account_id field')
+  }
+  return {
+    externalId: raw.callback_virtual_account_id,
+    paymentMethod: raw.payment_method,
+    idempotencyKeyPrefix: 'xendit:va',
+  }
+}
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/xendit-va/types.ts
+++ b/src/features/payments/webhooks/xendit-va/types.ts
@@ -0,0 +1,38 @@
+/**
+ * Xendit Fixed Virtual Account webhook types.
+ *
+ * XenditVaPayload is the raw Xendit FVA callback body.
+ * route.ts casts to this type, then normalizes before dispatching.
+ * handlers.ts never imports this type. (ref: DL-013)
+ */
+import type { NormalizedWebhookPayload } from '@/lib/payments/types'
+
+export interface XenditVaPayload {
+  callback_virtual_account_id: string  // Xendit FVA ID — webhook lookup key (ref: DL-011)
+  status: string
+  payment_method?: string              // Bank code; preserved as Transaction.paymentMethod (ref: DL-020)
+}
+
+/**
+ * Maps Xendit FVA callback to NormalizedWebhookPayload.
+ *
+ * callback_virtual_account_id -> externalId: the Xendit FVA ID stored in
+ * Transaction.externalId at creation; processPaymentCapture looks up by this ID. (ref: DL-011)
+ *
+ * Sets idempotencyKeyPrefix='xendit:va' so handlers construct
+ * xendit:va:PAID:{fvaId} keys — distinct from invoice namespace. (ref: DL-010)
+ */
+export function normalizeXenditVaPayload(raw: XenditVaPayload): NormalizedWebhookPayload {

```


### Milestone 6: VA webhook route and app-router mount

**Files**: src/features/payments/webhooks/xendit-va/route.ts, src/app/api/webhooks/xendit-va/route.ts

#### Code Intent

- **CI-M-006-001** `src/features/payments/webhooks/xendit-va/route.ts`: VA webhook route handler: calls verifyXenditToken(request) for auth (DL-005). Parses raw body as XenditVaPayload. Calls normalizeXenditVaPayload(payload) to get NormalizedWebhookPayload. Dispatches on payload.status: 'COMPLETED' -> processPaymentCapture(normalized); 'EXPIRED' -> processPaymentFailed(normalized); 'FAILED' -> processPaymentFailed(normalized); 'PENDING' and 'ACTIVE' -> return NextResponse.json({ received: true }) no-op (VA created but not yet paid — informational only); any other unrecognized status -> return NextResponse.json({ received: true }) no-op (DL-019). Returns 200 on success; catches and returns 500 on thrown errors (same pattern as invoice route.ts). (refs: DL-005, DL-013, DL-019)
- **CI-M-006-002** `src/app/api/webhooks/xendit-va/route.ts`: Re-exports POST from src/features/payments/webhooks/xendit-va/route.ts. No logic. (refs: DL-013)

#### Code Changes

**CC-M-006-001** (src/features/payments/webhooks/xendit-va/route.ts) - implements CI-M-006-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/xendit-va/route.ts
@@ -0,0 +1,53 @@
+/**
+ * Xendit FVA payment webhook POST handler.
+ *
+ * Normalization boundary: verifies auth, parses XenditVaPayload, normalizes to
+ * NormalizedWebhookPayload, dispatches to handlers. handlers.ts never imports
+ * XenditVaPayload. (ref: DL-013, DL-005)
+ *
+ * Status dispatch (ref: DL-019):
+ *   COMPLETED -> processPaymentCapture
+ *   EXPIRED, FAILED -> processPaymentFailed
+ *   PENDING, ACTIVE, unknown -> 200 no-op
+ */
+import { NextRequest, NextResponse } from 'next/server'
+import { processPaymentCapture, processPaymentFailed } from '../handlers'
+import { type XenditVaPayload, normalizeXenditVaPayload } from './types'
+import { verifyXenditToken } from '@/lib/payments/webhook-auth'
+
+export async function POST(req: NextRequest): Promise<NextResponse> {
+  const secret = process.env.XENDIT_WEBHOOK_TOKEN
+  if (!secret) {
+    return NextResponse.json({ error: 'Webhook token not configured.' }, { status: 500 })
+  }
+
+  // verifyXenditToken covers both invoice and VA callbacks — same x-callback-token mechanism. (ref: DL-005)
+  if (!verifyXenditToken(req, secret)) {
+    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
+  }
+
+  let payload: XenditVaPayload
+  let normalized
+  try {
+    const parsed = (await req.json()) as unknown
+    if (!parsed || typeof parsed !== 'object') {
+      return NextResponse.json({ error: 'Malformed Xendit VA payload.' }, { status: 400 })
+    }
+    payload = parsed as XenditVaPayload
+    normalized = normalizeXenditVaPayload(payload)
+  } catch (err) {
+    if (err instanceof Error) {
+      return NextResponse.json({ error: err.message }, { status: 400 })
+    }
+    throw err
+  }
+
+  const status = (payload.status ?? '').toUpperCase()
+  console.info(`[va-webhook] callback_virtual_account_id=${payload.callback_virtual_account_id} status=${status}`)
+
+  switch (status) {
+    case 'COMPLETED':
+      await processPaymentCapture(normalized)
+      break
+    case 'EXPIRED':
+    case 'FAILED':
+      await processPaymentFailed(normalized)
+      break
+    default:
+      console.info(`[va-webhook] no-op status=${status}`)
+  }
+
+  return NextResponse.json({ received: true })
+}

```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/xendit-va/route.ts
+++ b/src/features/payments/webhooks/xendit-va/route.ts
@@ -0,0 +1,53 @@
+/**
+ * Xendit FVA payment webhook POST handler.
+ *
+ * Normalization boundary: verifies auth, parses XenditVaPayload, normalizes to
+ * NormalizedWebhookPayload with idempotencyKeyPrefix='xendit:va', dispatches to
+ * handlers. handlers.ts never imports XenditVaPayload. (ref: DL-013, DL-005)
+ *
+ * Status dispatch (ref: DL-019):
+ *   COMPLETED -> processPaymentCapture
+ *   EXPIRED, FAILED -> processPaymentFailed
+ *   PENDING, ACTIVE, unknown -> 200 no-op (prevents Xendit retry storms)
+ *
+ * Auth: reuses verifyXenditToken — Xendit uses the same x-callback-token mechanism
+ * for FVA callbacks as for invoice callbacks. (ref: DL-005)
+ */
+export async function POST(req: NextRequest): Promise<NextResponse> {

```


**CC-M-006-002** (src/app/api/webhooks/xendit-va/route.ts) - implements CI-M-006-002

**Code:**

```diff
--- /dev/null
+++ b/src/app/api/webhooks/xendit-va/route.ts
@@ -0,0 +1 @@
+export { POST } from '@/features/payments/webhooks/xendit-va/route'

```

**Documentation:**

```diff
--- a/src/app/api/webhooks/xendit-va/route.ts
+++ b/src/app/api/webhooks/xendit-va/route.ts
@@ -0,0 +1,1 @@
+// App Router wiring — logic lives in src/features/payments/webhooks/xendit-va/route.ts.
+export { POST } from '@/features/payments/webhooks/xendit-va/route'

```


**CC-M-006-003** (src/features/payments/webhooks/xendit-va/route.ts) - implements CI-M-006-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/xendit-va/route.ts
@@ -0,0 +1,53 @@
+/**
+ * Xendit Fixed Virtual Account webhook POST handler.
+ *
+ * Mirrors the invoice webhook route structure: verifies x-callback-token,
+ * normalizes XenditVaPayload to NormalizedWebhookPayload with idempotencyKeyPrefix,
+ * then dispatches to processPaymentCapture / processPaymentFailed.
+ *
+ * Same auth mechanism as invoice webhooks — Xendit uses x-callback-token for FVA
+ * callbacks. (ref: DL-008)
+ */
+import { NextRequest, NextResponse } from 'next/server'
+import { processPaymentCapture, processPaymentFailed } from '../handlers'
+import { type XenditVaPayload, normalizeXenditVaPayload } from './types'
+import { verifyXenditToken } from '@/lib/payments/webhook-auth'
+
+export async function POST(req: NextRequest): Promise<NextResponse> {
+  const secret = process.env.XENDIT_WEBHOOK_TOKEN
+  if (!secret) {
+    return NextResponse.json({ error: 'Webhook token not configured.' }, { status: 500 })
+  }
+
+  if (!verifyXenditToken(req, secret)) {
+    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
+  }
+
+  let payload: XenditVaPayload
+  let normalized
+  try {
+    const parsed = (await req.json()) as unknown
+    if (!parsed || typeof parsed !== 'object') {
+      return NextResponse.json({ error: 'Malformed Xendit VA payload.' }, { status: 400 })
+    }
+    payload = parsed as XenditVaPayload
+    normalized = normalizeXenditVaPayload(payload)
+  } catch (err) {
+    if (err instanceof Error) {
+      return NextResponse.json({ error: err.message }, { status: 400 })
+    }
+    throw err
+  }
+
+  const status = (payload.status ?? ''\).toUpperCase()
+  console.info(`[webhook:va] received payload id=${payload.callback_virtual_account_id} status=${status}`)
+
+  if (status === ''\) {
+    throw new Error('Xendit VA webhook missing payload.status')
+  }
+
+  switch (status) {
+    case 'PAID':
+      console.info(`[webhook:va] dispatch to processPaymentCapture id=${payload.callback_virtual_account_id}`)
+      await processPaymentCapture(normalized)
+      break
+    case 'EXPIRED':
+      console.info(`[webhook:va] dispatch to processPaymentFailed id=${payload.callback_virtual_account_id}`)
+      await processPaymentFailed(normalized)
+      break
+    default:
+      console.info(`[webhook:va] acknowledged-without-processing id=${payload.callback_virtual_account_id} status=${status}`)
+  }
+
+  return NextResponse.json({ received: true })
+}
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/xendit-va/route.ts
+++ b/src/features/payments/webhooks/xendit-va/route.ts
@@ -0,0 +1,53 @@
+/**
+ * Xendit Fixed Virtual Account webhook POST handler.
+ *
+ * Mirrors the invoice webhook route: verifies x-callback-token,
+ * normalizes XenditVaPayload to NormalizedWebhookPayload with
+ * idempotencyKeyPrefix='xendit:va', dispatches to handlers. (ref: DL-013)
+ *
+ * Auth: verifyXenditToken reused — Xendit uses x-callback-token for FVA
+ * callbacks, identical to invoice callbacks. (ref: DL-005)
+ *
+ * Dispatch (ref: DL-019):
+ *   COMPLETED -> processPaymentCapture
+ *   EXPIRED | FAILED -> processPaymentFailed
+ *   other -> 200 no-op
+ */
+export async function POST(req: NextRequest): Promise<NextResponse> {

```


**CC-M-006-004** (src/app/api/webhooks/xendit-va/route.ts) - implements CI-M-006-002

**Code:**

```diff
--- /dev/null
+++ b/src/app/api/webhooks/xendit-va/route.ts
@@ -0,0 +1,2 @@
+// App Router wiring — logic lives in src/features/payments/webhooks/xendit-va/route.ts.
+export { POST } from '@/features/payments/webhooks/xendit-va/route'
```

**Documentation:**

```diff
--- a/src/app/api/webhooks/xendit-va/route.ts
+++ b/src/app/api/webhooks/xendit-va/route.ts
@@ -0,0 +1,2 @@
+// App Router wiring — logic lives in src/features/payments/webhooks/xendit-va/route.ts.
+export { POST } from '@/features/payments/webhooks/xendit-va/route'

```


**CC-M-006-005** (src/features/payments/webhooks/xendit-va/README.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/xendit-va/README.md
@@ -0,0 +1,103 @@
+# payments/webhooks/xendit-va
+
+Xendit Fixed Virtual Account (FVA) webhook handler. Receives POST callbacks from
+Xendit after a PESONet bank transfer, authenticates the request, and advances
+Transaction and Order records atomically — reusing the same handlers as the
+invoice webhook. (ref: DL-013)
+
+## Request flow
+
+1. Client submits bank selector form on order-detail; `initiateVaCheckout` creates
+   a Xendit FVA via POST `/callback_virtual_accounts` and writes a PENDING Transaction
+   with `externalId = Xendit FVA id` and `vaNumber = account_number`.
+2. Client transfers the exact `expected_amount` to the VA number at their bank.
+3. Xendit POSTs `{ callback_virtual_account_id, status, bank_code, ... }` to
+   `/api/webhooks/xendit-va`.
+4. `route.ts` calls `verifyXenditToken` — same `x-callback-token` mechanism and
+   `XENDIT_WEBHOOK_TOKEN` env var as the invoice webhook. (ref: DL-005)
+5. `route.ts` casts body to `XenditVaPayload`, calls `normalizeXenditVaPayload` to
+   produce `NormalizedWebhookPayload { externalId, paymentMethod, idempotencyKeyPrefix: 'xendit:va' }`.
+6. `route.ts` dispatches on `payload.status` (ref: DL-019):
+   - `COMPLETED` → `processPaymentCapture`
+   - `EXPIRED` | `FAILED` → `processPaymentFailed`
+   - `PENDING`, `ACTIVE`, unknown → 200 no-op (prevents Xendit retry storms)
+7. `processPaymentCapture` and `processPaymentFailed` run unchanged — the only
+   difference is `idempotencyKeyPrefix = 'xendit:va'` producing keys
+   `xendit:va:PAID:{fvaId}` and `xendit:va:EXPIRED:{fvaId}`. (ref: DL-004, DL-010)
+8. `$transaction` errors propagate as 500 — Xendit retries on non-2xx.
+
+## Two-ID scheme (VA path)
+
+| Field | Value | Direction | Purpose |
+|-------|-------|-----------|---------|
+| `Transaction.id` | Our cuid | Sent TO Xendit as `external_id` at FVA creation | Internal primary key |
+| `Transaction.externalId` | Xendit FVA `id` | Stored FROM Xendit FVA creation response | Webhook lookup key |
+
+`callback_virtual_account_id` in the webhook payload equals `Transaction.externalId`
+(the Xendit FVA id, not our cuid). `normalizeXenditVaPayload` maps
+`callback_virtual_account_id → externalId` — not `external_id → externalId`. (ref: DL-011)
+
+## Idempotency
+
+Identical two-layer structure to the invoice webhook (see `../README.md`):
+
+- Layer 1: `IdempotencyKey` with keys `xendit:va:PAID:{fvaId}` and `xendit:va:EXPIRED:{fvaId}`.
+  Keys in the `xendit:va` namespace are distinct from `xendit:invoice` keys — no cross-product collision. (ref: DL-010)
+- Layer 2: `Transaction.status` guard — CAPTURED/FAILED terminal checks inside `$transaction`.
+
+## FVA constraints enforced at creation (ref: DL-001, DL-003, DL-016)
+
+| Constraint | Xendit parameter | Effect |
+|------------|-----------------|--------|
+| Full-amount only | `expected_amount = Transaction.amount.toNumber()` | Xendit only fires COMPLETED when the exact amount is received |
+| Single-payment | `is_closed: true` | VA auto-closes after first deposit; prevents double-credit from a second transfer |
+| 72h expiry | `expiration_date = Date.now() + 72h` | Orphaned FVAs (DB write failed after Xendit call) expire without manual cleanup; EXPIRED webhook arrives as a no-op |
+
+## EXPIRED / FAILED recovery
+
+`EXPIRED` and `FAILED` statuses route to `processPaymentFailed`, which transitions
+Order to `PAYMENT_FAILED`. The existing retry CTA from T-08 renders on `PAYMENT_FAILED`
+orders, letting clients initiate a new VA via `initiateVaCheckout`. A second
+`initiateVaCheckout` call creates a new Transaction row; `order-detail` fetches
+`take: 1, orderBy: { createdAt: desc }` to show the most recent VA. (ref: DL-014, DL-015)
+
+## Invariants
+
+- `handlers.ts` imports zero provider-specific types; only `xendit-va/route.ts`
+  references `XenditVaPayload`. (ref: DL-013)
+- `processPaymentCapture` and `processPaymentFailed` contain zero VA-specific logic.
+  The idempotencyKeyPrefix one-liner is the only change to those functions.
+- `PaymentCapturedEvent.amount` comes from `Transaction.amount` (Decimal), not the
+  webhook-reported amount — prevents float drift. (ref: DL-003)
+- `Transaction.vaNumber` is a typed nullable column, not stored in `metadata` JSON.
+  RSC DTOs can SELECT it directly without a cast. (ref: DL-002)
+
+## Required env vars
+
+| Variable | Description |
+|----------|-------------|
+| `XENDIT_WEBHOOK_TOKEN` | Shared with invoice webhook — Xendit uses the same token for FVA callbacks |
+| `XENDIT_SECRET_KEY` | Used by `createXenditVa` in `initiateVaCheckout` to authenticate FVA creation |
+
+## Test strategy
+
+| File | Tests | DB strategy |
+|------|-------|-------------|
+| `__tests__/normalize.test.ts` | normalizeXenditVaPayload field mapping and idempotencyKeyPrefix | Unit (no DB) |
+| `__tests__/handlers.test.ts` | COMPLETED capture, duplicate dedup, EXPIRED failure, orphan no-op, R-003 FVA collision guard | Real test DB (`DATABASE_TEST_URL`) |
+| `src/lib/payments/__tests__/xendit-va.test.ts` | createXenditVa request body, result shape, error handling | Unit (fetch mock) |


```


### Milestone 7: initiateVaCheckout Server Action

**Files**: src/features/payments/checkout/action.ts

#### Code Intent

- **CI-M-007-001** `src/features/payments/checkout/action.ts`: Adds initiateVaCheckout(_prevState, formData) Server Action with useActionState-compatible signature. Reads orderId and bankCode from formData. Returns { message } error states for: missing orderId/bankCode, non-CLIENT session, order not found or not owned, order status !== PAYMENT_PENDING, quotedPrice.toNumber() < PESONET_MIN_AMOUNT, isPesonetBankCode(bankCode) false. Guards for any existing PENDING Transaction regardless of type (invoice or VA) — returns error message, no duplicate VA creation (see DL-015). Calls createXenditVa with transactionId cuid as externalId, bankCode, order.service.name as name, order.quotedPrice.toNumber() as expectedAmount, new Date(Date.now() + 72*60*60*1000) as expirationDate. Transaction.create with vaId in externalId, provider xendit-va, vaNumber from result.accountNumber, paymentMethod from bankCode. redirect to /dashboard/orders/{orderId} as last statement after try/catch. (refs: DL-006, DL-007, DL-012, DL-015, DL-017, DL-018)

#### Code Changes

**CC-M-007-001** (src/features/payments/checkout/action.ts) - implements CI-M-007-001

**Code:**

```diff
--- a/src/features/payments/checkout/action.ts
+++ b/src/features/payments/checkout/action.ts
@@ -33,4 +33,6 @@ import { auth } from '@/lib/auth'
 import { createXenditInvoice, XenditApiError } from '@/lib/payments/xendit'
+import { createXenditVa, XenditVaError } from '@/lib/payments/xendit-va'
+import { isPesonetBankCode, PESONET_MIN_AMOUNT } from '@/domain/payments/pesonet'
 
 type ActionState = { message?: string } | null

@@ -117,5 +119,87 @@ export async function initiateCheckout(
   redirect(checkoutUrl)
 }
+
+/**
+ * Server action for PESONet Virtual Account checkout.
+ *
+ * Sequence (mirrors initiateCheckout for VA path, ref: DL-006):
+ *   1. Validate formData (orderId, bankCode present).
+ *   2. Auth guard — CLIENT session required.
+ *   3. Re-fetch Order and verify ownership + status === PAYMENT_PENDING (TOCTOU guard).
+ *   4. Amount guard — quotedPrice must exceed PESONET_MIN_AMOUNT (server-side, ref: DL-009).
+ *   5. Bank code guard — isPesonetBankCode() validates against allowlist (ref: DL-009).
+ *   6. Idempotency guard — any existing PENDING Transaction blocks new VA creation (ref: DL-015).
+ *   7. Generate transactionId cuid — used as Transaction.id and Xendit external_id (ref: DL-017).
+ *   8. Call createXenditVa BEFORE DB write (ref: DL-015).
+ *   9. Transaction.create with vaId in externalId, vaNumber, paymentMethod.
+ *  10. redirect to order-detail as last statement (ref: DL-007).
+ *
+ * Invariant: redirect() is never inside try/catch.
+ */
+export async function initiateVaCheckout(
+  _prevState: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const orderId = formData.get('orderId') as string | null
+  const bankCode = formData.get('bankCode') as string | null
+  if (!orderId) return { message: 'Missing order ID.' }
+  if (!bankCode) return { message: 'Missing bank code.' }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    include: { service: true },
+  })
+
+  if (!order || order.clientId !== session.user.id) {
+    return { message: 'Order not found.' }
+  }
+  if (order.status !== OrderStatus.PAYMENT_PENDING) {
+    return { message: 'Order is not awaiting payment.' }
+  }
+  if (!order.quotedPrice) {
+    return { message: 'Order does not have a quoted price.' }
+  }
+
+  // Amount threshold: server-side guard mirrors UI gate (dual-layer, ref: DL-009)
+  if (order.quotedPrice.toNumber() <= PESONET_MIN_AMOUNT) {
+    return { message: 'PESONet is only available for orders above ₱50,000.' }
+  }
+
+  // Bank code validation: allowlist enforced server-side to prevent injection (ref: DL-009)
+  if (!isPesonetBankCode(bankCode)) {
+    return { message: 'Invalid bank code.' }
+  }
+
+  // Any existing PENDING Transaction blocks VA creation — prevents double VA for same order (ref: DL-015)
+  const existingPending = await prisma.transaction.findFirst({
+    where: { orderId, status: TransactionStatus.PENDING },
+  })
+  if (existingPending) {
+    return { message: 'A payment is already in progress for this order.' }
+  }
+
+  const transactionId = createId()
+
+  let redirectPath: string
+  try {
+    // Xendit call before DB write: if DB fails, FVA expires in 72h (orphan tolerance, ref: DL-015)
+    const result = await createXenditVa({
+      externalId: transactionId,
+      bankCode,
+      name: order.service.name,
+      // Decimal.toNumber() safe for PHP amounts — no precision loss below Number.MAX_SAFE_INTEGER (ref: DL-018)
+      expectedAmount: order.quotedPrice.toNumber(),
+      expirationDate: new Date(Date.now() + 72 * 60 * 60 * 1000),
+    })
+
+    await prisma.transaction.create({
+      data: {
+        id: transactionId,
+        orderId,
+        // vaId (Xendit FVA ID) in externalId — webhook lookup uses this ID (two-ID scheme, ref: DL-017)
+        externalId: result.vaId,
+        provider: 'xendit-va',
+        amount: order.quotedPrice,
+        currency: 'PHP',
+        status: TransactionStatus.PENDING,
+        vaNumber: result.accountNumber,
+        paymentMethod: result.bankCode,
+      },
+    })
+
+    redirectPath = `/dashboard/orders/${orderId}`
+  } catch (err) {
+    if (err instanceof XenditVaError) {
+      return { message: 'Payment service error. Please try again.' }
+    }
+    return { message: 'Unable to reach payment service. Please try again later.' }
+  }
+
+  // redirect() after try/catch — Next.js throws NEXT_REDIRECT internally (ref: CLAUDE.md Implementation Discipline)
+  redirect(redirectPath)
+}

```

**Documentation:**

```diff
--- a/src/features/payments/checkout/action.ts
+++ b/src/features/payments/checkout/action.ts
@@ -117,6 +117,60 @@
   redirect(checkoutUrl)
 }
+
+/**
+ * Server action for PESONet Fixed Virtual Account checkout.
+ *
+ * Sequence (ref: DL-006, DL-007):
+ *   1. Parse orderId and bankCode from formData; validate bankCode via isPesonetBankCode.
+ *   2. Auth guard — CLIENT session required.
+ *   3. Re-fetch Order with ownership check (TOCTOU guard).
+ *   4. Validate Order is PAYMENT_PENDING and quotedPrice >= PESONET_MIN_AMOUNT.
+ *   5. Idempotency guard — return error if any PENDING Transaction already exists. (ref: DL-015)
+ *   6. Generate transactionId cuid; call createXenditVa with expected_amount and 72h expiry. (ref: DL-012, DL-017, DL-018)
+ *   7. Write Transaction (PENDING, vaNumber, externalId=Xendit FVA id) inside $transaction. (ref: DL-002)
+ *   8. redirect('/dashboard/orders/{orderId}') after try/catch — never inside. (ref: DL-007)
+ *
+ * On Xendit call success + DB write failure: FVA expires after 72h; EXPIRED webhook arrives
+ * as a no-op; Order remains PAYMENT_PENDING; client retries via existing CTA. (ref: DL-015)
+ */
+export async function initiateVaCheckout(

```


**CC-M-007-002** (src/features/payments/checkout/action.ts) - implements CI-M-007-001

**Code:**

```diff
--- a/src/features/payments/checkout/action.ts
+++ b/src/features/payments/checkout/action.ts
@@ -1,6 +1,7 @@
 'use server'
 
 /**
+ * Checkout actions for both Xendit invoice (initiateCheckout) and
+ * Xendit Fixed Virtual Account (initiateVaCheckout) payment flows.
  * Server action for the deferred-payment checkout flow.
  *
@@ -29,8 +30,14 @@ import { createId } from '@paralleldrive/cuid2'
 import { prisma } from '@/lib/prisma'
 import { auth } from '@/lib/auth'
 import { createXenditInvoice, XenditApiError } from '@/lib/payments/xendit'
+import { createXenditVa } from '@/lib/payments/xendit-va'
+import { isPesonetBankCode, PESONET_MIN_AMOUNT } from '@/domain/payments/pesonet'
 
 type ActionState = { message?: string } | null
+
+const VA_EXPIRY_HOURS = 72
+
+// initiateCheckout unchanged below...
 
 /** useActionState-compatible signature. Wraps the full checkout flow. */
 export async function initiateCheckout(
@@ -119,3 +120,86 @@ export async function initiateCheckout(
 
   redirect(checkoutUrl)
 }
+
+/**
+ * Server Action for the PESONet Fixed Virtual Account checkout flow.
+ *
+ * Only available for orders >= PESONET_MIN_AMOUNT (PHP 50,000).
+ * Sequence:
+ *   1. Validate formData (orderId, bankCode).
+ *   2. Auth guard — CLIENT session required.
+ *   3. Re-fetch Order + clientProfile + service from DB (TOCTOU guard).
+ *   4. Amount threshold guard (dual-layer — UI also validates).
+ *   5. Bank code allowlist guard (server-side via isPesonetBankCode).
+ *   6. Idempotency guard — if a PENDING Transaction with a vaNumber exists,
+ *      redirect to order-detail (VA instructions are already there).
+ *   7. Call createXenditVa BEFORE writing to DB (ref: DL-002).
+ *   8. Prisma Transaction.create — stores fvaId in externalId, VA number in vaNumber.
+ *   9. redirect() to order-detail as the LAST statement.
+ *
+ * redirect() is never inside try/catch (Implementation Discipline).
+ */
+export async function initiateVaCheckout(
+  _prevState: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const orderId = formData.get('orderId') as string | null
+  const bankCode = formData.get('bankCode') as string | null
+
+  if (!orderId) return { message: 'Missing order ID.' }
+  if (!bankCode) return { message: 'Missing bank code.' }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    include: { clientProfile: true, service: true },
+  })
+
+  if (!order || order.clientId !== session.user.id) {
+    return { message: 'Order not found.' }
+  }
+  if (order.status !== 'PAYMENT_PENDING') {
+    return { message: 'Order is not awaiting payment.' }
+  }
+  if (!order.clientProfile) {
+    return { message: 'Order profile is incomplete.' }
+  }
+  if (!order.quotedPrice) {
+    return { message: 'Order does not have a quoted price.' }
+  }
+
+  const amountNumber = order.quotedPrice.toNumber()
+  if (amountNumber < PESONET_MIN_AMOUNT) {
+    return { message: `PESONet is only available for orders of PHP ${PESONET_MIN_AMOUNT.toLocaleString()} or more.` }
+  }
+
+  if (!isPesonetBankCode(bankCode)) {
+    return { message: 'Invalid bank selection.' }
+  }
+
+  const existing = await prisma.transaction.findFirst({
+    where: { orderId, status: 'PENDING', vaNumber: { not: null } },
+  })
+  if (existing?.vaNumber) {
+    redirect(`/dashboard/orders/${orderId}`)
+  }
+
+  const transactionId = createId()
+  const expirationDate = new Date(Date.now() + VA_EXPIRY_HOURS * 60 * 60 * 1000).toISOString()
+
+  let orderDetailUrl: string
+  try {
+    const result = await createXenditVa({
+      externalId: transactionId,
+      bankCode,
+      name: order.clientProfile.name,
+      expectedAmount: amountNumber,
+      expirationDate,
+    })
+
+    await prisma.transaction.create({
+      data: {
+        id: transactionId,
+        orderId,
+        externalId: result.fvaId,
+        provider: 'xendit',
+        amount: order.quotedPrice,
+        currency: 'PHP',
+        status: 'PENDING',
+        vaNumber: result.accountNumber,
+        metadata: result.rawResponse as Prisma.InputJsonValue,
+      },
+    })
+
+    orderDetailUrl = `/dashboard/orders/${orderId}`
+  } catch (err) {
+    if (err instanceof XenditApiError) {
+      return { message: 'Payment service error. Please try again.' }
+    }
+    return { message: 'Unable to reach payment service. Please try again later.' }
+  }
+
+  redirect(orderDetailUrl)
+}
```

**Documentation:**

```diff
--- a/src/features/payments/checkout/action.ts
+++ b/src/features/payments/checkout/action.ts
@@ -1,5 +1,9 @@
 'use server'
 
+/**
+ * Checkout Server Actions: initiateCheckout (Xendit invoice) and initiateVaCheckout (PESONet FVA).
+ * Both follow the same sequence: auth, TOCTOU re-fetch, idempotency guard, Xendit call, DB write, redirect.
+ * Separate actions because flows diverge at the Xendit API call and Transaction shape. (ref: DL-006)
+ */
 /**
  * Server action for the deferred-payment checkout flow.

```


### Milestone 8: Order-detail VA UI — bank selector and VA instructions

**Files**: src/features/orders/order-detail/page.tsx, src/features/orders/order-detail/ui.tsx

#### Code Intent

- **CI-M-008-001** `src/features/orders/order-detail/page.tsx`: Prisma query gains include for transactions (orderBy createdAt desc, take 1) to retrieve most recent Transaction. OrderDetailDTO gains vaNumber: string | null and transactionPaymentMethod: string | null fields. DTO mapping: vaNumber from transaction?.vaNumber ?? null, transactionPaymentMethod from transaction?.paymentMethod ?? null. PAYMENT_PENDING render path: if vaNumber set, pass VA instructions props; if quotedPrice amount > PESONET_MIN_AMOUNT and no vaNumber, pass bank selector props; otherwise render existing card pay link only. (refs: DL-008, DL-009, DL-014)
- **CI-M-008-002** `src/features/orders/order-detail/ui.tsx`: Adds OrderDetailVaInstructions client component rendered when vaNumber is set and order status is PAYMENT_PENDING: displays bank name (transactionPaymentMethod), account number (vaNumber), amount (quotedPrice), and expiry note. Adds OrderDetailVaBankSelector client component rendered when order status is PAYMENT_PENDING and quotedPrice.toNumber() > PESONET_MIN_AMOUNT and vaNumber is null: contains bank code dropdown (PESONET_BANK_CODES as options), hidden orderId input, calls initiateVaCheckout via useActionState. Both components only render at PAYMENT_PENDING status. (refs: DL-008, DL-009)

#### Code Changes

**CC-M-008-001** (src/features/orders/order-detail/page.tsx) - implements CI-M-008-001

**Code:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -2,7 +2,9 @@ import { notFound, redirect } from 'next/navigation'
 import { OrderStatus, PricingMode } from '@prisma/client'
 import { prisma } from '@/lib/prisma'
 import { auth } from '@/lib/auth'
 import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
-import { OrderDetailQuoteActions, OrderDetailRetryPayment } from './ui'
+import { OrderDetailQuoteActions, OrderDetailRetryPayment, OrderDetailVaInstructions, OrderDetailVaBankSelector } from './ui'
+import { PESONET_MIN_AMOUNT } from '@/domain/payments/pesonet'
 
@@ -41,6 +41,8 @@ export type OrderDetailDTO = {
   quantity: number
   notes: string | null
+  vaNumber: string | null
+  transactionPaymentMethod: string | null
 }
 
@@ -181,7 +181,13 @@ export default async function OrderDetailPage({
     include: {
       service: { select: { name: true, pricingMode: true } },
       lab:     { select: { name: true } },
       clientProfile: true,
+      // Most-recent Transaction for VA number display; take:1 handles retry case with multiple Transactions (ref: DL-014)
+      transactions: {
+        orderBy: { createdAt: 'desc' },
+        take: 1,
+      },
     },
   })
 
@@ -207,6 +207,8 @@ export default async function OrderDetailPage({
     quantity: order.quantity,
     notes: order.notes ?? null,
+    vaNumber: order.transactions[0]?.vaNumber ?? null,
+    transactionPaymentMethod: order.transactions[0]?.paymentMethod ?? null,
   }
 
@@ -368,6 +368,20 @@ export default async function OrderDetailPage({
         {dto.status === 'QUOTE_PROVIDED' && dto.quotedPrice != null && (
           <OrderDetailQuoteActions orderId={dto.id} quotedPrice={dto.quotedPrice} />
         )}
 
         {dto.status === 'PAYMENT_FAILED' && (
           <OrderDetailRetryPayment orderId={dto.id} />
         )}
+
+        {dto.status === 'PAYMENT_PENDING' && dto.vaNumber != null && (
+          <OrderDetailVaInstructions
+            bankCode={dto.transactionPaymentMethod}
+            vaNumber={dto.vaNumber}
+            quotedPrice={dto.quotedPrice ?? '0.00'}
+          />
+        )}
+
+        {/* Bank selector: PAYMENT_PENDING, amount above threshold, no VA created yet (ref: DL-008, DL-009) */}
+        {dto.status === 'PAYMENT_PENDING' && dto.vaNumber == null &&
+          dto.quotedPrice != null && Number(dto.quotedPrice) > PESONET_MIN_AMOUNT && (
+          <OrderDetailVaBankSelector orderId={dto.id} />
+        )}
 
         {dto.status === 'QUOTE_REJECTED' && (

```

**Documentation:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -41,6 +41,10 @@
   quantity: number
   notes: string | null
+  // vaNumber and transactionPaymentMethod come from the most recent Transaction (take: 1, desc).
+  // Multiple Transactions may exist when a client retries after PAYMENT_FAILED;
+  // take: 1 ensures the UI shows the current VA, not an older expired one. (ref: DL-014)
+  vaNumber: string | null
+  transactionPaymentMethod: string | null
   clientName: string | null

```


**CC-M-008-002** (src/features/orders/order-detail/ui.tsx) - implements CI-M-008-002

**Code:**

```diff
--- a/src/features/orders/order-detail/ui.tsx
+++ b/src/features/orders/order-detail/ui.tsx
@@ -1,7 +1,9 @@
 'use client'
 
 import { useActionState } from 'react'
 import { Card, CardContent } from '@/components/ui/card'
 import { Button } from '@/components/ui/button'
 import { acceptQuote, rejectQuote, retryPayment } from './action'
+import { initiateVaCheckout } from '@/features/payments/checkout/action'
+import { PESONET_BANK_CODES } from '@/domain/payments/pesonet'
 
@@ -73,3 +73,55 @@ export function OrderDetailRetryPayment({
   )
 }
+
+/** Displays VA instructions after bank transfer setup — rendered when vaNumber is set. */
+export function OrderDetailVaInstructions({
+  bankCode,
+  vaNumber,
+  quotedPrice,
+}: {
+  bankCode: string | null
+  vaNumber: string
+  quotedPrice: string
+}) {
+  return (
+    <Card className="mt-4">
+      <CardContent className="pt-6">
+        <p className="text-sm font-semibold text-gray-900 mb-3">PESONet Bank Transfer Instructions</p>
+        <dl className="divide-y divide-gray-100 text-sm">
+          {bankCode && (
+            <div className="flex justify-between py-2">
+              <dt className="text-gray-500">Bank</dt>
+              <dd className="text-gray-900 font-medium">{bankCode}</dd>
+            </div>
+          )}
+          <div className="flex justify-between py-2">
+            <dt className="text-gray-500">Account Number</dt>
+            <dd className="text-gray-900 font-mono font-semibold">{vaNumber}</dd>
+          </div>
+          <div className="flex justify-between py-2">
+            <dt className="text-gray-500">Amount</dt>
+            <dd className="text-gray-900 font-semibold">₱{quotedPrice}</dd>
+          </div>
+        </dl>
+        <p className="mt-3 text-xs text-gray-500">
+          Transfer the exact amount above. The virtual account expires in 72 hours.
+        </p>
+      </CardContent>
+    </Card>
+  )
+}
+
+/** Bank code selector for initiating PESONet VA — rendered when PAYMENT_PENDING and no VA exists. */
+export function OrderDetailVaBankSelector({ orderId }: { orderId: string }) {
+  const [state, formAction] = useActionState(initiateVaCheckout, null)
+
+  return (
+    <Card className="mt-4">
+      <CardContent className="pt-6">
+        <p className="text-sm text-gray-700 mb-4">
+          Pay via PESONet bank transfer. Select your bank to receive a virtual account number.
+        </p>
+        <form action={formAction} className="flex flex-col gap-3">
+          <input type="hidden" name="orderId" value={orderId} />
+          <select
+            name="bankCode"
+            required
+            className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
+          >
+            <option value="">Select bank…</option>
+            {PESONET_BANK_CODES.map((code) => (
+              <option key={code} value={code}>{code}</option>
+            ))}
+          </select>
+          <Button type="submit">Set Up Bank Transfer</Button>
+        </form>
+        {state?.message && (
+          <p className="mt-2 text-sm text-red-600">{state.message}</p>
+        )}
+      </CardContent>
+    </Card>
+  )
+}

```

**Documentation:**

```diff
--- a/src/features/orders/order-detail/ui.tsx
+++ b/src/features/orders/order-detail/ui.tsx
@@ -73,3 +73,55 @@
 }
+
+/**
+ * Renders VA payment instructions after bank selector submission.
+ * Visible when vaNumber is set on the DTO — indicates initiateVaCheckout succeeded. (ref: DL-007)
+ */
+export function OrderDetailVaInstructions({

```


**CC-M-008-003** (src/features/orders/order-detail/page.tsx) - implements CI-M-008-001

**Code:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -6,7 +6,7 @@
 import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
-import { OrderDetailQuoteActions, OrderDetailRetryPayment } from './ui'
+import { OrderDetailQuoteActions, OrderDetailRetryPayment, OrderDetailVaInstructions } from './ui'
 
@@ -27,6 +27,8 @@
   paidAt: string | null
   clientName: string | null
+  vaNumber: string | null
+  vaBankCode: string | null
   clientEmail: string | null
 
@@ -181,6 +185,11 @@
   const order = await prisma.order.findUnique({
     where: { id: params.orderId },
     include: {
       service: { select: { name: true, pricingMode: true } },
       lab:     { select: { name: true } },
       clientProfile: true,
+      transactions: {
+        where: { status: 'PENDING', vaNumber: { not: null } },
+        orderBy: { createdAt: 'desc' },
+        take: 1,
+      },
     },
   })
 
@@ -200,6 +206,8 @@
   const dto: OrderDetailDTO = {
     id: order.id,
+    vaNumber: order.transactions[0]?.vaNumber ?? null,
+    vaBankCode: order.transactions[0]?.paymentMethod ?? null,
     status: order.status,
     pricingMode: order.service.pricingMode,
 
@@ -370,6 +378,12 @@
         {dto.status === 'PAYMENT_FAILED' && (
           <OrderDetailRetryPayment orderId={dto.id} />
         )}
+
+        {dto.status === 'PAYMENT_PENDING' && dto.vaNumber != null && (
+          <OrderDetailVaInstructions
+            vaNumber={dto.vaNumber}
+            bankCode={dto.vaBankCode ?? ''}
+            amount={dto.quotedPrice ?? '0.00'}
+          />
+        )}
 
         {dto.status === 'QUOTE_REJECTED' && (
```

**Documentation:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -27,6 +27,10 @@
   paidAt: string | null
   clientName: string | null
+  // vaNumber and vaBankCode from most recent Transaction (orderBy createdAt desc, take: 1). (ref: DL-014)
+  // take: 1 with desc ordering: multiple Transactions arise when client retries after PAYMENT_FAILED.
+  vaNumber: string | null
+  vaBankCode: string | null
   clientEmail: string | null

```


**CC-M-008-004** (src/features/orders/order-detail/ui.tsx) - implements CI-M-008-002

**Code:**

```diff
--- a/src/features/orders/order-detail/ui.tsx
+++ b/src/features/orders/order-detail/ui.tsx
@@ -1,7 +1,11 @@
 'use client'
 
 import { useActionState } from 'react'
 import { Card, CardContent } from '@/components/ui/card'
 import { Button } from '@/components/ui/button'
-import { acceptQuote, rejectQuote, retryPayment } from './action'
+import { acceptQuote, rejectQuote, retryPayment, initiateVaCheckout } from './action'
+import { PESONET_BANK_CODES, PESONET_BANK_LABELS, PESONET_MIN_AMOUNT } from '@/domain/payments/pesonet'
+import type { PesonetBankCode } from '@/domain/payments/pesonet'
 
 export function OrderDetailQuoteActions({
@@ -73,3 +77,80 @@ export function OrderDetailRetryPayment({
     </Card>
   )
 }
+
+/**
+ * Bank selector and VA initiation form for PAYMENT_PENDING orders >= PHP 50,000.
+ * Rendered only when dto.status === PAYMENT_PENDING and dto.vaNumber is null
+ * (VA not yet created). Once VA is created, OrderDetailVaInstructions renders instead.
+ */
+export function OrderDetailVaBankSelector({
+  orderId,
+  quotedPrice,
+}: {
+  orderId: string
+  quotedPrice: string
+}) {
+  const amount = parseFloat(quotedPrice)
+  if (amount < PESONET_MIN_AMOUNT) return null
+
+  const [state, formAction] = useActionState(initiateVaCheckout, null)
+
+  return (
+    <Card className="mt-4">
+      <CardContent className="pt-6">
+        <p className="text-sm text-gray-700 mb-4">
+          Transfer via PESONet bank transfer. Select your bank and we will provide
+          a virtual account number for your payment.
+        </p>
+        <form action={formAction} className="space-y-3">
+          <input type="hidden" name="orderId" value={orderId} />
+          <div>
+            <label htmlFor="bankCode" className="block text-sm font-medium text-gray-700 mb-1">
+              Select Bank
+            </label>
+            <select
+              id="bankCode" name="bankCode" required
+              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
+              <option value="">Choose a bank...</option>
+              {PESONET_BANK_CODES.map((code) => (
+                <option key={code} value={code}>
+                  {PESONET_BANK_LABELS[code as PesonetBankCode]}
+                </option>
+              ))}
+            </select>
+          </div>
+          <Button type="submit">
+            Get Virtual Account Number
+          </Button>
+        </form>
+        {state?.message && (
+          <p className="mt-2 text-sm text-red-600">{state.message}</p>
+        )}
+      </CardContent>
+    </Card>
+  )
+}
+
+/**
+ * VA instructions panel — displayed once a VA has been created.
+ * Shows the account number, bank, and amount to transfer.
+ */
+export function OrderDetailVaInstructions({
+  vaNumber,
+  bankCode,
+  amount,
+}: {
+  vaNumber: string
+  bankCode: string
+  amount: string
+}) {
+  return (
+    <Card className="mt-4">
+      <CardContent className="pt-6">
+        <p className="text-sm font-medium text-gray-900 mb-3">PESONet Bank Transfer Instructions</p>
+        <dl className="divide-y divide-gray-100 text-sm">
+          <div className="flex justify-between py-2">
+            <dt className="text-gray-500">Bank</dt>
+            <dd className="text-gray-900">{bankCode}</dd>
+          </div>
+          <div className="flex justify-between py-2">
+            <dt className="text-gray-500">Virtual Account Number</dt>
+            <dd className="font-mono text-gray-900">{vaNumber}</dd>
+          </div>
+          <div className="flex justify-between py-2">
+            <dt className="text-gray-500">Amount to Transfer</dt>
+            <dd className="font-semibold text-gray-900">₱{amount}</dd>
+          </div>
+        </dl>
+        <p className="mt-3 text-xs text-gray-500">
+          Transfer the exact amount to the virtual account above. Your payment will be confirmed
+          automatically once received by the bank.
+        </p>
+      </CardContent>
+    </Card>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/orders/order-detail/ui.tsx
+++ b/src/features/orders/order-detail/ui.tsx
@@ -77,3 +77,80 @@
 }
+
+/**
+ * Bank selector form for PAYMENT_PENDING orders above PESONET_MIN_AMOUNT.
+ * Submits bankCode + orderId to initiateVaCheckout; redirects to order-detail on success.
+ * Renders only when no vaNumber is set — avoids duplicate VA creation. (ref: DL-008, DL-015)
+ */
+export function OrderDetailVaBankSelector({

```


### Milestone 9: Tests — normalize unit, VA client unit, integration

**Files**: src/features/payments/webhooks/xendit-va/__tests__/normalize.test.ts, src/lib/payments/__tests__/xendit-va.test.ts, src/features/payments/webhooks/xendit-va/__tests__/handlers.test.ts

**Acceptance Criteria**:

- normalizeXenditVaPayload unit tests pass: maps callback_virtual_account_id, handles missing bank_code, throws on invalid externalId
- createXenditVa unit tests pass: success path returns XenditVaResult, non-2xx throws XenditVaError, missing key throws XenditVaError(500)
- Integration: VA COMPLETED webhook transitions Transaction to CAPTURED and Order to next status with IdempotencyKey xendit:va:PAID:{id}
- Integration: duplicate COMPLETED delivery is deduped by IdempotencyKey check — no double-transition
- Integration: VA EXPIRED webhook transitions Transaction to FAILED and Order to PAYMENT_FAILED
- Integration: orphan COMPLETED (unknown externalId) returns 200 without error — no unhandled exception

#### Code Intent

- **CI-M-009-001** `src/features/payments/webhooks/xendit-va/__tests__/normalize.test.ts`: Unit tests for normalizeXenditVaPayload: maps callback_virtual_account_id to externalId, bank_code to paymentMethod, sets idempotencyKeyPrefix to xendit:va; produces undefined paymentMethod when bank_code absent; throws on null, empty string, whitespace-only, and non-string callback_virtual_account_id. Mirrors normalize.test.ts pattern from invoice slice. (refs: DL-011)
- **CI-M-009-002** `src/lib/payments/__tests__/xendit-va.test.ts`: Unit tests for createXenditVa with mocked fetch: success returns correct XenditVaResult shape; non-2xx throws XenditVaError with correct status; absent XENDIT_SECRET_KEY throws XenditVaError(500). No real network calls. (refs: DL-001)
- **CI-M-009-003** `src/features/payments/webhooks/xendit-va/__tests__/handlers.test.ts`: Integration tests using real Neon DB via testPrisma: seeds Transaction with externalId = xendit_va_id (simulating initiateVaCheckout write). Tests: (1) VA COMPLETED webhook payload normalized and dispatched to processPaymentCapture resulting in Transaction CAPTURED and Order status advanced and IdempotencyKey xendit:va:PAID:{id} created; (2) duplicate COMPLETED delivery returns without re-processing (IdempotencyKey dedup); (3) VA EXPIRED dispatched to processPaymentFailed resulting in Transaction FAILED and Order PAYMENT_FAILED; (4) orphan COMPLETED for unknown externalId (no matching Transaction) returns 200 without error — this is a no-op since processPaymentCapture will not find a Transaction. Cleanup of IdempotencyKey, Transaction, Order rows in beforeEach/afterAll. (refs: DL-015)

#### Code Changes

**CC-M-009-001** (src/features/payments/webhooks/xendit-va/__tests__/normalize.test.ts) - implements CI-M-009-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/xendit-va/__tests__/normalize.test.ts
@@ -0,0 +1,44 @@
+import { describe, it, expect } from 'vitest'
+import { normalizeXenditVaPayload } from '../types'
+
+describe('normalizeXenditVaPayload', () => {
+  it('maps callback_virtual_account_id to externalId', () => {
+    const payload = { callback_virtual_account_id: 'fva_xyz', external_id: 'txn_cuid', bank_code: 'BPI', status: 'COMPLETED' }
+    const result = normalizeXenditVaPayload(payload)
+    expect(result.externalId).toBe('fva_xyz')
+  })
+
+  it('maps bank_code to paymentMethod', () => {
+    const payload = { callback_virtual_account_id: 'fva_xyz', external_id: 'txn_cuid', bank_code: 'BDO', status: 'COMPLETED' }
+    const result = normalizeXenditVaPayload(payload)
+    expect(result.paymentMethod).toBe('BDO')
+  })
+
+  it('sets idempotencyKeyPrefix to xendit:va', () => {
+    const payload = { callback_virtual_account_id: 'fva_xyz', external_id: 'txn_cuid', status: 'COMPLETED' }
+    const result = normalizeXenditVaPayload(payload)
+    expect(result.idempotencyKeyPrefix).toBe('xendit:va')
+  })
+
+  it('produces undefined paymentMethod when bank_code absent', () => {
+    const payload = { callback_virtual_account_id: 'fva_xyz', external_id: 'txn_cuid', status: 'COMPLETED' }
+    const result = normalizeXenditVaPayload(payload)
+    expect(result.paymentMethod).toBeUndefined()
+  })
+
+  it('throws on null callback_virtual_account_id', () => {
+    expect(() => normalizeXenditVaPayload({ callback_virtual_account_id: null as unknown as string, external_id: 'txn', status: 'COMPLETED' }))
+      .toThrow('Xendit VA payload missing required callback_virtual_account_id field')
+  })
+
+  it('throws on empty string callback_virtual_account_id', () => {
+    expect(() => normalizeXenditVaPayload({ callback_virtual_account_id: '', external_id: 'txn', status: 'COMPLETED' }))
+      .toThrow('Xendit VA payload missing required callback_virtual_account_id field')
+  })
+
+  it('throws on whitespace-only callback_virtual_account_id', () => {
+    expect(() => normalizeXenditVaPayload({ callback_virtual_account_id: '   ', external_id: 'txn', status: 'COMPLETED' }))
+      .toThrow('Xendit VA payload missing required callback_virtual_account_id field')
+  })
+})

```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/xendit-va/__tests__/normalize.test.ts
+++ b/src/features/payments/webhooks/xendit-va/__tests__/normalize.test.ts
@@ -0,0 +1,44 @@
+/**
+ * Unit tests for normalizeXenditVaPayload.
+ * Verifies that callback_virtual_account_id maps to externalId (not external_id),
+ * and that idempotencyKeyPrefix is 'xendit:va'. (ref: DL-011, DL-010)
+ */

```


**CC-M-009-002** (src/lib/payments/__tests__/xendit-va.test.ts) - implements CI-M-009-002

**Code:**

```diff
--- /dev/null
+++ b/src/lib/payments/__tests__/xendit-va.test.ts
@@ -0,0 +1,52 @@
+import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
+import { createXenditVa, XenditVaError } from '../xendit-va'
+
+const mockFetch = vi.fn()
+vi.stubGlobal('fetch', mockFetch)
+
+beforeEach(() => {
+  vi.resetAllMocks()
+  process.env.XENDIT_SECRET_KEY = 'test_key'
+})
+
+afterEach(() => {
+  // Restore env var deleted in absent-key test to prevent cross-file leakage under shared worker pools.
+  process.env.XENDIT_SECRET_KEY = 'test_key'
+})
+
+describe('createXenditVa', () => {
+  it('returns XenditVaResult on success', async () => {
+    const mockRaw = { id: 'fva_123', account_number: '8001234567', bank_code: 'BPI', external_id: 'txn_cuid' }
+    mockFetch.mockResolvedValueOnce({
+      ok: true,
+      json: () => Promise.resolve(mockRaw),
+    })
+
+    const result = await createXenditVa({
+      externalId: 'txn_cuid', bankCode: 'BPI', name: 'Test Service',
+      expectedAmount: 75000, expirationDate: new Date('2026-01-01'),
+    })
+
+    expect(result.vaId).toBe('fva_123')
+    expect(result.accountNumber).toBe('8001234567')
+    expect(result.bankCode).toBe('BPI')
+  })
+
+  it('throws XenditVaError on non-2xx response', async () => {
+    mockFetch.mockResolvedValueOnce({
+      ok: false,
+      status: 400,
+      text: () => Promise.resolve('Bad Request'),
+    })
+
+    await expect(createXenditVa({
+      externalId: 'x', bankCode: 'BPI', name: 'svc',
+      expectedAmount: 75000, expirationDate: new Date(),
+    })).rejects.toThrow(XenditVaError)
+  })
+
+  it('throws XenditVaError(500) when XENDIT_SECRET_KEY absent', async () => {
+    delete process.env.XENDIT_SECRET_KEY
+
+    await expect(createXenditVa({
+      externalId: 'x', bankCode: 'BPI', name: 'svc',
+      expectedAmount: 75000, expirationDate: new Date(),
+    })).rejects.toThrow(XenditVaError)
+  })
+})

```

**Documentation:**

```diff
--- a/src/lib/payments/__tests__/xendit-va.test.ts
+++ b/src/lib/payments/__tests__/xendit-va.test.ts
@@ -0,0 +1,52 @@
+/**
+ * Unit tests for createXenditVa.
+ * Mocks global fetch; verifies request body (is_closed: true, expected_amount,
+ * expirationDate), XenditVaResult shape, and error handling. (ref: DL-016, DL-003)
+ *
+ * afterEach restores XENDIT_SECRET_KEY to prevent cross-test leakage
+ * under shared worker pools.
+ */

```


**CC-M-009-003** (src/features/payments/webhooks/xendit-va/__tests__/handlers.test.ts) - implements CI-M-009-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/xendit-va/__tests__/handlers.test.ts
@@ -0,0 +1,140 @@
+/**
+ * Integration tests for VA webhook dispatch.
+ * Uses real Neon DB via testPrisma (DATABASE_TEST_URL in .env.test).
+ * Seeds a Transaction with externalId = Xendit FVA ID to simulate initiateVaCheckout write.
+ *
+ * Test cases (ref: DL-015, DL-019):
+ *   1. COMPLETED -> processPaymentCapture advances Transaction and Order
+ *   2. Duplicate COMPLETED deduped by IdempotencyKey
+ *   3. EXPIRED -> processPaymentFailed transitions to PAYMENT_FAILED
+ *   4. Orphan COMPLETED (unknown externalId) -> 200 no-op without error
+ *   5. PAID-for-FAILED (R-007 symmetric) -> throws rather than overwriting terminal FAILED
+ */
+import { describe, it, expect, beforeEach, afterAll } from 'vitest'
+import { OrderStatus, TransactionStatus } from '@prisma/client'
+import { testPrisma } from '@/test/test-prisma'
+import { processPaymentCapture, processPaymentFailed } from '../../handlers'
+
+const TEST_FVA_ID = 'fva_test_integration_001'
+
+async function seedTransaction(overrides: { status?: TransactionStatus; fvaId?: string } = {}) {
+  const owner = await testPrisma.user.create({ data: { email: `owner-${Date.now()}@test.com`, role: 'LAB_ADMIN' } })
+  const lab = await testPrisma.lab.create({ data: { name: 'Test Lab', ownerId: owner.id } })
+  const service = await testPrisma.labService.create({
+    data: { labId: lab.id, name: 'VA Test Service', basePrice: 75000, pricingMode: 'QUOTE_REQUIRED', category: 'CHEMICAL_TESTING' }
+  })
+  const client = await testPrisma.user.create({ data: { email: `client-${Date.now()}@test.com`, role: 'CLIENT' } })
+  const order = await testPrisma.order.create({
+    data: { clientId: client.id, labId: lab.id, serviceId: service.id, status: OrderStatus.PAYMENT_PENDING, quantity: 1, quotedPrice: 75000, quotedAt: new Date() }
+  })
+  const transaction = await testPrisma.transaction.create({
+    data: {
+      orderId: order.id, externalId: overrides.fvaId ?? TEST_FVA_ID, provider: 'xendit-va',
+      amount: 75000, currency: 'PHP',
+      status: overrides.status ?? TransactionStatus.PENDING,
+      vaNumber: '8001234567', paymentMethod: 'BPI',
+    }
+  })
+  return { owner, lab, service, client, order, transaction }
+}
+
+async function cleanupAll() {
+  await testPrisma.idempotencyKey.deleteMany({ where: { key: { startsWith: 'xendit:va:' } } })
+  await testPrisma.transaction.deleteMany({ where: { externalId: { startsWith: 'fva_test' } } })
+  await testPrisma.order.deleteMany({ where: { quotedPrice: 75000, quantity: 1 } })
+  await testPrisma.labService.deleteMany({ where: { name: 'VA Test Service' } })
+  await testPrisma.lab.deleteMany({ where: { name: 'Test Lab' } })
+  await testPrisma.user.deleteMany({ where: { email: { endsWith: '@test.com' } } })
+}
+
+describe('VA webhook integration', () => {
+  beforeEach(async () => {
+    // Full cleanup between tests prevents unique-constraint violations on Transaction.externalId.
+    await cleanupAll()
+  })
+
+  afterAll(async () => {
+    await cleanupAll()
+  })
+
+  it('COMPLETED: advances Transaction to CAPTURED and Order to ACKNOWLEDGED', async () => {
+    const { order } = await seedTransaction()
+
+    await processPaymentCapture({ externalId: TEST_FVA_ID, paymentMethod: 'BPI', idempotencyKeyPrefix: 'xendit:va' })
+
+    const txn = await testPrisma.transaction.findUnique({ where: { externalId: TEST_FVA_ID } })
+    expect(txn?.status).toBe(TransactionStatus.CAPTURED)
+
+    const updatedOrder = await testPrisma.order.findUnique({ where: { id: order.id } })
+    expect(updatedOrder?.status).toBe(OrderStatus.ACKNOWLEDGED)
+
+    const key = await testPrisma.idempotencyKey.findUnique({ where: { key: `xendit:va:PAID:${TEST_FVA_ID}` } })
+    expect(key).not.toBeNull()
+  })
+
+  it('Duplicate COMPLETED: deduped by IdempotencyKey — no double-transition', async () => {
+    await seedTransaction()
+
+    // First call: transitions Transaction and creates IdempotencyKey
+    await processPaymentCapture({ externalId: TEST_FVA_ID, idempotencyKeyPrefix: 'xendit:va' })
+    const countBefore = await testPrisma.idempotencyKey.count({ where: { key: `xendit:va:PAID:${TEST_FVA_ID}` } })
+
+    // Second call: hits IdempotencyKey dedup, returns early without re-processing
+    await processPaymentCapture({ externalId: TEST_FVA_ID, idempotencyKeyPrefix: 'xendit:va' })
+    const countAfter = await testPrisma.idempotencyKey.count({ where: { key: `xendit:va:PAID:${TEST_FVA_ID}` } })
+
+    expect(countBefore).toBe(1)
+    expect(countAfter).toBe(1)
+  })
+
+  it('EXPIRED: transitions Transaction to FAILED and Order to PAYMENT_FAILED', async () => {
+    const { order } = await seedTransaction()
+
+    await processPaymentFailed({ externalId: TEST_FVA_ID, idempotencyKeyPrefix: 'xendit:va' })
+
+    const txn = await testPrisma.transaction.findUnique({ where: { externalId: TEST_FVA_ID } })
+    expect(txn?.status).toBe(TransactionStatus.FAILED)
+
+    const updatedOrder = await testPrisma.order.findUnique({ where: { id: order.id } })
+    expect(updatedOrder?.status).toBe(OrderStatus.PAYMENT_FAILED)
+  })
+
+  it('Orphan COMPLETED: unknown externalId returns without error (no Transaction found)', async () => {
+    await expect(
+      processPaymentCapture({ externalId: 'fva_unknown_orphan', idempotencyKeyPrefix: 'xendit:va' })
+    ).resolves.toBeUndefined()
+  })
+
+  it('PAID-for-FAILED (R-007 symmetric): throws when Transaction.status is already FAILED', async () => {
+    // Seeds Transaction at FAILED status — simulates EXPIRED-then-PAID race where EXPIRED webhook already arrived.
+    await seedTransaction({ status: TransactionStatus.FAILED })
+
+    await expect(
+      processPaymentCapture({ externalId: TEST_FVA_ID, idempotencyKeyPrefix: 'xendit:va' })
+    ).rejects.toThrow('Refusing to capture FAILED transaction')
+  })
+})

```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/xendit-va/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/xendit-va/__tests__/handlers.test.ts
@@ -0,0 +1,140 @@
+/**
+ * Integration tests for VA webhook dispatch.
+ * Uses real Neon DB via testPrisma (DATABASE_TEST_URL in .env.test).
+ * Seeds a Transaction with externalId = Xendit FVA ID to simulate initiateVaCheckout write.
+ *
+ * Cases (ref: DL-015, DL-019):
+ *   1. COMPLETED -> processPaymentCapture advances Transaction and Order
+ *   2. Duplicate COMPLETED deduped by IdempotencyKey (Layer 1)
+ *   3. EXPIRED -> processPaymentFailed transitions to PAYMENT_FAILED
+ *   4. Orphan COMPLETED (unknown externalId) -> 200 no-op
+ *   5. PAID-after-FAILED terminal guard -> throws, refuses CAPTURED overwrite on terminal FAILED Transaction
+ */

```


**CC-M-009-004** (src/features/payments/webhooks/xendit-va/__tests__/normalize.test.ts) - implements CI-M-009-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/xendit-va/__tests__/normalize.test.ts
@@ -0,0 +1,55 @@
+import { describe, it, expect } from 'vitest'
+import { normalizeXenditVaPayload } from '../types'
+import type { XenditVaPayload } from '../types'
+
+describe('normalizeXenditVaPayload', () => {
+  it('maps callback_virtual_account_id to externalId and sets idempotencyKeyPrefix', () => {
+    const raw: XenditVaPayload = {
+      callback_virtual_account_id: 'xendit-fva-abc',
+      status: 'PAID',
+      payment_method: 'BPI',
+    }
+
+    const result = normalizeXenditVaPayload(raw)
+
+    expect(result.externalId).toBe('xendit-fva-abc')
+    expect(result.paymentMethod).toBe('BPI')
+    expect(result.idempotencyKeyPrefix).toBe('xendit:va')
+  })
+
+  it('produces undefined paymentMethod when payment_method is absent', () => {
+    const raw: XenditVaPayload = {
+      callback_virtual_account_id: 'xendit-fva-def',
+      status: 'EXPIRED',
+    }
+
+    const result = normalizeXenditVaPayload(raw)
+
+    expect(result.externalId).toBe('xendit-fva-def')
+    expect(result.paymentMethod).toBeUndefined()
+    expect(result.idempotencyKeyPrefix).toBe('xendit:va')
+  })
+
+  it('throws when callback_virtual_account_id is null', () => {
+    const raw = { callback_virtual_account_id: null, status: 'PAID' } as unknown as XenditVaPayload
+    expect(() => normalizeXenditVaPayload(raw)).toThrow(/missing required callback_virtual_account_id/)
+  })
+
+  it('throws when callback_virtual_account_id is empty string', () => {
+    const raw: XenditVaPayload = { callback_virtual_account_id: '', status: 'PAID' }
+    expect(() => normalizeXenditVaPayload(raw)).toThrow(/missing required callback_virtual_account_id/)
+  })
+
+  it('throws when callback_virtual_account_id is a non-string value', () => {
+    const raw = { callback_virtual_account_id: 12345, status: 'PAID' } as unknown as XenditVaPayload
+    expect(() => normalizeXenditVaPayload(raw)).toThrow(/missing required callback_virtual_account_id/)
+  })
+
+  it('throws when callback_virtual_account_id is whitespace-only', () => {
+    const raw: XenditVaPayload = { callback_virtual_account_id: '   ', status: 'PAID' }
+    expect(() => normalizeXenditVaPayload(raw)).toThrow(/missing required callback_virtual_account_id/)
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/xendit-va/__tests__/normalize.test.ts
+++ b/src/features/payments/webhooks/xendit-va/__tests__/normalize.test.ts
@@ -0,0 +1,55 @@
+/**
+ * Unit tests for normalizeXenditVaPayload.
+ * Verifies externalId = callback_virtual_account_id (not external_id), (ref: DL-011)
+ * idempotencyKeyPrefix = 'xendit:va', (ref: DL-010)
+ * and paymentMethod = payment_method (bank code preserved). (ref: DL-020)
+ */

```


**CC-M-009-005** (src/lib/payments/__tests__/xendit-va.test.ts) - implements CI-M-009-002

**Code:**

```diff
--- /dev/null
+++ b/src/lib/payments/__tests__/xendit-va.test.ts
@@ -0,0 +1,75 @@
+import { describe, it, expect, vi, beforeEach } from 'vitest'
+import { createXenditVa, XenditApiError } from '../xendit-va'
+
+const mockFetch = vi.fn()
+vi.stubGlobal('fetch', mockFetch)
+
+beforeEach(() => {
+  vi.unstubAllEnvs()
+  mockFetch.mockReset()
+})
+
+describe('createXenditVa', () => {
+  it('throws XenditApiError when XENDIT_SECRET_KEY is not set', async () => {
+    vi.stubEnv('XENDIT_SECRET_KEY', '')
+
+    await expect(
+      createXenditVa({
+        externalId: 'test-ext-id',
+        bankCode: 'BPI',
+        name: 'Test Client',
+        expectedAmount: 75000,
+        expirationDate: '2026-06-01T00:00:00.000Z',
+      }),
+    ).rejects.toThrow(XenditApiError)
+  })
+
+  it('sends correct request body and returns fvaId and accountNumber on success', async () => {
+    vi.stubEnv('XENDIT_SECRET_KEY', 'test-secret')
+    mockFetch.mockResolvedValueOnce({
+      ok: true,
+      json: async () => ({
+        id: 'fva-id-123',
+        account_number: '9999-001-12345678',
+        bank_code: 'BPI',
+      }),
+    })
+
+    const result = await createXenditVa({
+      externalId: 'test-ext-id',
+      bankCode: 'BPI',
+      name: 'Test Client',
+      expectedAmount: 75000,
+      expirationDate: '2026-06-01T00:00:00.000Z',
+    })
+
+    expect(result.fvaId).toBe('fva-id-123')
+    expect(result.accountNumber).toBe('9999-001-12345678')
+    expect(result.rawResponse).toMatchObject({ id: 'fva-id-123' })
+
+    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit]
+    expect(url).toBe('https://api.xendit.co/callback_virtual_accounts')
+    const body = JSON.parse(options.body as string) as Record<string, unknown>
+    expect(body.external_id).toBe('test-ext-id')
+    expect(body.bank_code).toBe('BPI')
+    expect(body.expected_amount).toBe(75000)
+    expect(body.is_closed).toBe(true)
+    expect(body.is_single_use).toBe(true)
+  })
+
+  it('throws XenditApiError on non-2xx response', async () => {
+    vi.stubEnv('XENDIT_SECRET_KEY', 'test-secret')
+    mockFetch.mockResolvedValueOnce({
+      ok: false,
+      status: 422,
+      text: async () => '{"error_code":"INVALID_BANK_CODE"}',
+    })
+
+    await expect(
+      createXenditVa({
+        externalId: 'test-ext-id',
+        bankCode: 'INVALID',
+        name: 'Test Client',
+        expectedAmount: 75000,
+        expirationDate: '2026-06-01T00:00:00.000Z',
+      }),
+    ).rejects.toThrow(XenditApiError)
+  })
+})
```

**Documentation:**

```diff
--- a/src/lib/payments/__tests__/xendit-va.test.ts
+++ b/src/lib/payments/__tests__/xendit-va.test.ts
@@ -0,0 +1,75 @@
+/**
+ * Unit tests for createXenditVa (infrastructure layer).
+ * Mocks global fetch; verifies request body shape (is_closed: true, expected_amount as number),
+ * XenditVaResult mapping, and XenditApiError on non-2xx. (ref: DL-016, DL-003, DL-018)
+ *
+ * vi.unstubAllEnvs() in beforeEach prevents XENDIT_SECRET_KEY state leakage.
+ */

```


**CC-M-009-006** (src/features/payments/webhooks/xendit-va/__tests__/handlers.test.ts) - implements CI-M-009-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/xendit-va/__tests__/handlers.test.ts
@@ -0,0 +1,120 @@
+import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
+import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode } from '@prisma/client'
+import { testPrisma } from '@/test/test-prisma'
+import { processPaymentCapture, processPaymentFailed } from '../../handlers'
+import type { NormalizedWebhookPayload } from '@/lib/payments/types'
+
+vi.mock('@/lib/prisma', async () => {
+  const { testPrisma: client } = await import('@/test/test-prisma')
+  return { prisma: client }
+})
+
+vi.mock('@/lib/auth', () => ({
+  auth: vi.fn().mockResolvedValue({
+    user: { id: 'va-test-user-lab', role: 'LAB_ADMIN' },
+  }),
+}))
+vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
+vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
+
+const TEST_CLIENT_ID = 'va-test-user-client'
+const TEST_LAB_USER_ID = 'va-test-user-lab'
+const TEST_LAB_ID = 'va-test-lab'
+const TEST_SERVICE_ID = 'va-test-service'
+const TEST_ORDER_ID = 'va-test-order-1'
+const TEST_ORDER_ID_2 = 'va-test-order-2'
+const TEST_FVA_EXT_1 = 'xendit-fva-ext-1'
+const TEST_FVA_EXT_2 = 'xendit-fva-ext-2'
+
+async function cleanup() {
+  await testPrisma.idempotencyKey.deleteMany({
+    where: {
+      key: {
+        in: [
+          `xendit:va:PAID:${TEST_FVA_EXT_1}`,
+          `xendit:va:EXPIRED:${TEST_FVA_EXT_1}`,
+          `xendit:va:PAID:${TEST_FVA_EXT_2}`,
+          `xendit:va:EXPIRED:${TEST_FVA_EXT_2}`,
+        ],
+      },
+    },
+  })
+  await testPrisma.transaction.deleteMany({
+    where: { externalId: { in: [TEST_FVA_EXT_1, TEST_FVA_EXT_2] } },
+  })
+  await testPrisma.order.deleteMany({
+    where: { id: { in: [TEST_ORDER_ID, TEST_ORDER_ID_2] } },
+  })
+  await testPrisma.labService.deleteMany({ where: { id: TEST_SERVICE_ID } })
+  await testPrisma.lab.deleteMany({ where: { id: TEST_LAB_ID } })
+  await testPrisma.user.deleteMany({
+    where: { id: { in: [TEST_CLIENT_ID, TEST_LAB_USER_ID] } },
+  })
+}
+
+async function seedBase() {
+  await testPrisma.user.createMany({
+    data: [
+      { id: TEST_CLIENT_ID, email: 'va-client@test.local', role: UserRole.CLIENT },
+      { id: TEST_LAB_USER_ID, email: 'va-lab@test.local', role: UserRole.LAB_ADMIN },
+    ],
+    skipDuplicates: true,
+  })
+  await testPrisma.lab.upsert({
+    where: { id: TEST_LAB_ID },
+    update: {},
+    create: { id: TEST_LAB_ID, ownerId: TEST_LAB_USER_ID, name: 'VA Test Lab' },
+  })
+  await testPrisma.labService.upsert({
+    where: { id: TEST_SERVICE_ID },
+    update: {},
+    create: {
+      id: TEST_SERVICE_ID,
+      labId: TEST_LAB_ID,
+      name: 'VA Test Service',
+      category: ServiceCategory.CHEMICAL_TESTING,
+      pricingMode: PricingMode.FIXED,
+    },
+  })
+}
+
+beforeEach(async () => {
+  await cleanup()
+  await seedBase()
+})
+
+afterAll(async () => {
+  await cleanup()
+  await testPrisma.$disconnect()
+})
+
+describe('processPaymentCapture — VA idempotency key namespace', () => {
+  it('creates xendit:va:PAID:{fvaId} key and advances Transaction to CAPTURED', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID,
+        clientId: TEST_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.PAYMENT_PENDING,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'va-tx-1',
+        orderId: TEST_ORDER_ID,
+        externalId: TEST_FVA_EXT_1,
+        provider: 'xendit',
+        amount: '75000.00',
+        status: TransactionStatus.PENDING,
+        vaNumber: '9999-001-12345678',
+      },
+    })
+
+    const payload: NormalizedWebhookPayload = {
+      externalId: TEST_FVA_EXT_1,
+      idempotencyKeyPrefix: 'xendit:va',
+    }
+
+    await processPaymentCapture(payload)
+
+    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_FVA_EXT_1 } })
+    expect(tx!.status).toBe(TransactionStatus.CAPTURED)
+
+    const key = await testPrisma.idempotencyKey.findUnique({
+      where: { key: `xendit:va:PAID:${TEST_FVA_EXT_1}` },
+    })
+    expect(key).not.toBeNull()
+
+    const wrongKey = await testPrisma.idempotencyKey.findUnique({
+      where: { key: `xendit:invoice:PAID:${TEST_FVA_EXT_1}` },
+    })
+    expect(wrongKey).toBeNull()
+  })
+})
+
+describe('processPaymentFailed — VA idempotency key namespace', () => {
+  it('creates xendit:va:EXPIRED:{fvaId} key and transitions Order to PAYMENT_FAILED', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_2,
+        clientId: TEST_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.PAYMENT_PENDING,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'va-tx-2',
+        orderId: TEST_ORDER_ID_2,
+        externalId: TEST_FVA_EXT_2,
+        provider: 'xendit',
+        amount: '75000.00',
+        status: TransactionStatus.PENDING,
+        vaNumber: '9999-001-87654321',
+      },
+    })
+
+    const payload: NormalizedWebhookPayload = {
+      externalId: TEST_FVA_EXT_2,
+      idempotencyKeyPrefix: 'xendit:va',
+    }
+
+    await processPaymentFailed(payload)
+
+    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_FVA_EXT_2 } })
+    expect(tx!.status).toBe(TransactionStatus.FAILED)
+    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_2 } })
+    expect(order!.status).toBe(OrderStatus.PAYMENT_FAILED)
+
+    const keys = await testPrisma.idempotencyKey.findMany({
+      where: { key: `xendit:va:EXPIRED:${TEST_FVA_EXT_2}` },
+    })
+    expect(keys).toHaveLength(1)
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/xendit-va/__tests__/handlers.test.ts
+++ b/src/features/payments/webhooks/xendit-va/__tests__/handlers.test.ts
@@ -0,0 +1,120 @@
+/**
+ * Integration tests for VA webhook handlers using real test DB.
+ * Seeds Transaction with externalId = Xendit FVA ID (two-ID scheme). (ref: DL-017)
+ *
+ * Mirrors handlers.test.ts pattern from invoice webhook slice.
+ * Mock method names match handler Prisma call names exactly (Implementation Discipline).
+ */

```

