# create-order

## Overview

A CLIENT selects a `LabService` and submits a test request. The RSC fetches service data and hands a serialization-safe DTO to a client form shell. The Server Action re-fetches the service from the database, validates contact details against the domain schema, and writes `Order` + `ClientProfile` in a single transaction. Initial order status is determined entirely by the domain kernel (`resolveOrderInitialState`), not by any client-supplied value.

## Architecture

```
page.tsx (RSC)
  -> prisma.labService (fetch + include lab)
  -> CreateOrderServiceDTO (Decimal serialized to string)
  -> <OrderFormShell service={dto} userEmail={email} />  (ui.tsx)
       -> useActionState(createOrder)
       -> <HybridToggle />  (isolated Client Component)
       -> <form action={formAction}>

action.ts (Server Action)
  -> prisma.labService re-fetch (TOCTOU guard)
  -> auth() session verify
  -> clientDetailsSchema.safeParse()
  -> resolveOrderInitialState(freshService, requestCustomQuote)
  -> prisma.$transaction: Order.create + ClientProfile.create
  -> redirect()
```

`HybridToggle` is a separate Client Component boundary so that checkbox state changes do not re-render the entire form, which would reset all uncontrolled inputs.

## Design Decisions

**`Decimal` → `string` at the RSC boundary**: `LabService.pricePerUnit` is `Prisma.Decimal | null` at runtime. Passing it directly to a Client Component prop causes a Next.js serialization crash. The RSC converts it with `.toFixed(2)` before the prop boundary. `Decimal` must never appear in `ui.tsx` or `HybridToggle.tsx` props.

**TOCTOU re-fetch in the action**: The action ignores all service data carried in `FormData` and re-fetches `LabService` from the database before calling `resolveOrderInitialState`. This prevents a window between page load and form submit where a lab admin could change `pricingMode`, which would corrupt the initial order status if the stale client value were trusted.

**Hidden input for HYBRID checkbox**: Native HTML checkboxes are absent from `FormData` when unchecked. `HybridToggle` carries a `<input type="hidden" name="requestCustomQuote" value={String(state)}>` so the action receives `'true'` or `'false'` regardless of checkbox state.

**`quantity` hardcoded to `1`**: Domain invariant DL-quantity-001 — one sample per order creation. This is never user input. The invariant is enforced at the action write site, not by schema constraint.

**`redirect()` must be last**: In a `useActionState` Server Action, any `return` before `redirect()` suppresses navigation silently. The action has no `return` in its success branch; `redirect()` is the terminal statement.

**Address collapsed to one textarea**: The legacy form had three separate fields (street, city, postal). V2 `ClientProfile.address` is a single `String?` column. The form uses one `<textarea>` with a compound placeholder to guide format.

**`turnaroundDays` and `sampleRequirements` omitted**: Both fields existed in the legacy UI but are absent from the V2 `LabService` schema. They are omitted from the service detail card rather than silently added to the DTO. Revisit with a schema migration if product requires them.

## Invariants

- `CreateOrderServiceDTO.pricePerUnit` is always `string | null` — never `Prisma.Decimal`.
- `Order.quantity` is always `1` at creation; `resolveOrderInitialState` is the only gate for initial `Order.status`.
- The action re-fetches `LabService` from the DB on every submission; no service field from `FormData` is trusted for pricing or status logic.
- `redirect()` has no `return` before it in the success path.
- `ClientProfile` is created (not upserted); one `ClientProfile` per `Order` enforced by `orderId @unique` in schema.

## RA 10173 Privacy Compliance

**Sensitive-data flag**: `ServiceCategory.CHEMICAL_TESTING` and `ServiceCategory.BIOLOGICAL_TESTING` are classified as sensitive personal information categories under NPC guidelines. No dedicated column is added to `Order`; the `service.category` field on the related `LabService` is the flag. Querying sensitive orders: `where: { service: { category: { in: ['CHEMICAL_TESTING', 'BIOLOGICAL_TESTING'] } } }`.

**Consent record**: `ClientProfile.consentGiven` (`Boolean @default(false)`) and `ClientProfile.consentGivenAt` (`DateTime?`) are written inside the existing `$transaction` alongside `Order` and `ClientProfile`. The timestamp is server-side (`new Date()` in the action) to prevent client-supplied spoofing.

**Checkbox to FormData coercion**: Native HTML checkboxes send `'on'` when checked and are absent from `FormData` when unchecked. The consent checkbox uses a hidden input pattern (matching `HybridToggle`): `<input type="hidden" name="consentGiven" value={String(consentGiven)}>` ensures `FormData` always contains `'true'` or `'false'`. The action coerces `formData.get('consentGiven') === 'true'` to `true | undefined`; `clientDetailsSchema` uses `z.literal(true)`, so an unchecked box (`undefined`) fails `safeParse` and the submission is blocked.

**Privacy page**: Static RSC at `/privacy` (no auth required). Legal review is a prerequisite before the first commercial transaction; stub copy is acceptable for the PR.

**Self-service deletion**: Deferred to post-MVP. Clients may request data deletion via email; the request process is documented on the `/privacy` page.

### Invariants (additions for T-20)

- `ClientProfile.consentGiven` and `ClientProfile.consentGivenAt` are written inside the existing `$transaction` — never in a separate Prisma call — to preserve Order+ClientProfile atomicity. (ref: DL-004)
- `ServiceCategory.CHEMICAL_TESTING` and `ServiceCategory.BIOLOGICAL_TESTING` are the sensitive-personal-information flag under NPC guidelines; no Boolean column on `Order` duplicates this partition. (ref: DL-005)
- `ClientProfile` rows with consentGiven=false, consentGivenAt=null are dev/seed fixtures outside RA 10173 scope; seed data must be reset before production use. (ref: DL-012)
- Consent revocation/withdrawal mechanics are not implemented; consentGiven is write-once at order creation and is never mutated post-creation. (ref: DL-013)
- `prisma/migrations/` is gitignored — migration applied locally only; the PR commits only `schema.prisma` changes. (ref: DL-009)
