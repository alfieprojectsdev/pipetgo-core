# Plan 02 — Create Order Feature Slice

## Overview

Implement the `src/features/orders/create-order` vertical slice for V2. A client selects a
`LabService` from the marketplace and submits a test request. The slice maps to the legacy
`_legacy_v1/app/order/[serviceId]/page.tsx` UI but replaces every data-layer concern with V2
Server Actions and domain kernel primitives.

**Four files to create:**

| File | Kind | Role |
|---|---|---|
| `src/features/orders/create-order/page.tsx` | Async RSC | Fetches `LabService`, maps to DTO, renders `<OrderFormShell>` |
| `src/features/orders/create-order/ui.tsx` | `'use client'` | Form shell with `useActionState`; renders all fields and static alert variants |
| `src/features/orders/create-order/HybridToggle.tsx` | `'use client'` | HYBRID-only checkbox + conditional Alerts; isolated to prevent full-form re-renders |
| `src/features/orders/create-order/action.ts` | `'use server'` | Validates, re-fetches service, writes `Order` + `ClientProfile` in one transaction |

---

## Prerequisites

Read before implementing:

| File | Why |
|---|---|
| `src/domain/orders/client-details.ts` | `clientDetailsSchema` — exact Zod shape the action validates against |
| `src/domain/orders/pricing.ts` | `resolveOrderInitialState()` — determines initial status from `pricingMode` × `requestCustomQuote` |
| `src/domain/orders/state-machine.ts` | Documents which statuses are initial; confirms `PAYMENT_PENDING` and `QUOTE_REQUESTED` are both valid initial states |
| `prisma/schema.prisma` — `LabService`, `Order`, `ClientProfile` | Exact column names and types; confirms `pricePerUnit: Decimal?`, `Order.quantity: Int`, `ClientProfile.orderId @unique` |
| `src/_legacy_v1/app/order/[serviceId]/page.tsx` | Source of all JSX and Tailwind classes to keep |

---

## Data Contract

### Critical Invariant: `Decimal` must not cross the RSC→Client boundary

`LabService.pricePerUnit` is typed as `Prisma.Decimal | null` at runtime. Passing it directly
to a Client Component prop causes a Next.js serialization crash. The RSC **must** convert it
to `string | null` before the prop boundary.

### `CreateOrderServiceDTO` — exact type

Define this type in `page.tsx` (or a co-located `types.ts`):

```typescript
export type CreateOrderServiceDTO = {
  id: string
  name: string
  description: string | null
  category: string                        // ServiceCategory enum value (string is safe to pass)
  pricingMode: 'QUOTE_REQUIRED' | 'FIXED' | 'HYBRID'
  pricePerUnit: string | null             // Decimal.toFixed(2) or null — NEVER Prisma.Decimal
  unit: string | null
  lab: {
    name: string
    location: Record<string, unknown> | null  // Json? field — city, province, country keys
    certifications: string[]
  }
}
```

> **Flag — Missing V2 schema fields**: The legacy UI displayed `turnaroundDays` (number) and
> `sampleRequirements` (string) on the service detail card. Neither field exists in the V2
> `LabService` model (`prisma/schema.prisma` lines 150–168). **Decision required**: either
> (a) add both columns to the schema and generate a migration before implementing this slice,
> or (b) omit those sections from the V2 service detail card. Do not add them silently to the
> DTO. This plan assumes option (b) — omit — unless the schema is extended first.

### Legacy → V2 field mapping

| Legacy form field | HTML `name=` attr | Maps to | Notes |
|---|---|---|---|
| *(new)* | `name` | `ClientProfile.name` | Required. Not in legacy form; must be added. min 2 chars. |
| `contactEmail` | `email` | `ClientProfile.email` | Pre-fill from `auth()` session server-side |
| `contactPhone` | `phone` | `ClientProfile.phone` | Regex: `/^[0-9\s\-+()]+$/` |
| `organization` | `organization` | `ClientProfile.organization` | Optional |
| `street` + `city` + `postal` | `address` | `ClientProfile.address` | **Collapsed** — single `<textarea>` rows=2 |
| `sampleDescription` | `sampleDescription` | `Order.notes` (prefix) | min 10 chars (HTML5 `minlength`) |
| `specialInstructions` | `specialInstructions` | `Order.notes` (suffix, optional) | Joined with `\n\n` |
| `requestCustomQuote` | `requestCustomQuote` | `resolveOrderInitialState()` arg | HYBRID only; `'true'`/`'false'` string in FormData |
| *(implicit)* | — | `Order.quantity = 1` | **Hardcoded domain invariant** — never user input |
| *(implicit)* | — | `Order.clientId` | From `auth()` server-side |
| *(implicit)* | — | `Order.labId` | From fresh service re-fetch in action |
| *(implicit)* | — | `ClientProfile.address` country | Not captured; if needed, default to `'Philippines'` in address string hint |

---

## Implementation Steps

### Step 1 — Scaffold directory

```
src/features/orders/create-order/
├── page.tsx
├── ui.tsx
├── HybridToggle.tsx
└── action.ts
```

No `index.ts` barrel — Next.js App Router resolves `page.tsx` directly.

---

### Step 2 — `page.tsx` (Async RSC)

**Responsibilities:**
1. Receive `params: { serviceId: string }` from the App Router
2. Authenticate: call `auth()` (Next.js Auth); redirect to `/auth/signin` if no session or `role !== 'CLIENT'`
3. Fetch `LabService` with `lab` relation using Prisma
4. Call `notFound()` if the service doesn't exist or `isActive === false`
5. Map Prisma result → `CreateOrderServiceDTO` (convert `Decimal` → string)
6. Render `<OrderFormShell service={dto} />`

**Prisma query:**
```typescript
const service = await prisma.labService.findUnique({
  where: { id: params.serviceId, isActive: true },
  include: { lab: { select: { name: true, location: true, certifications: true } } },
})
if (!service) notFound()
```

**DTO mapping:**
```typescript
const dto: CreateOrderServiceDTO = {
  id: service.id,
  name: service.name,
  description: service.description,
  category: service.category,
  pricingMode: service.pricingMode,
  pricePerUnit: service.pricePerUnit?.toFixed(2) ?? null,  // Decimal → string
  unit: service.unit,
  lab: {
    name: service.lab.name,
    location: service.lab.location as Record<string, unknown> | null,
    certifications: service.lab.certifications,
  },
}
```

**No `'use client'` directive** — this file must be a Server Component.

---

### Step 3 — `action.ts` (Server Action)

**`'use server'` at the top of the file.**

Signature:
```typescript
export async function createOrder(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState>
```

Where `ActionState` is:
```typescript
type ActionState = {
  errors?: Partial<Record<string, string[]>>
  message?: string
} | null
```

**Implementation sequence (must follow this order):**

1. **Extract `serviceId`** from `formData.get('serviceId')` — passed as a hidden input from `ui.tsx`.

2. **Re-fetch `LabService`** from the database (TOCTOU guard):
   ```typescript
   const service = await prisma.labService.findUnique({
     where: { id: serviceId, isActive: true },
   })
   if (!service) return { message: 'Service no longer available.' }
   ```
   > Do not trust any `pricingMode` value from the client. The fresh DB read is the only
   > authoritative source for `resolveOrderInitialState()`.

3. **Authenticate** — call `auth()` and verify `session.user.role === 'CLIENT'`. Return error
   state (do not `redirect()`) if unauthenticated; the middleware should prevent this, but
   the action must be defensive.

4. **Parse and validate `clientDetails`** using `clientDetailsSchema`
   (`src/domain/orders/client-details.ts`):
   ```typescript
   const rawDetails = {
     name: formData.get('name'),
     email: formData.get('email'),
     phone: formData.get('phone'),
     organization: formData.get('organization') || undefined,
     address: formData.get('address') || undefined,
   }
   const parsed = clientDetailsSchema.safeParse(rawDetails)
   if (!parsed.success) {
     return { errors: parsed.error.flatten().fieldErrors }
   }
   ```

5. **Build `notes`** from `sampleDescription` and `specialInstructions`:
   ```typescript
   const sampleDescription = (formData.get('sampleDescription') as string).trim()
   const specialInstructions = (formData.get('specialInstructions') as string | null)?.trim()
   const notes = specialInstructions
     ? `${sampleDescription}\n\n${specialInstructions}`
     : sampleDescription
   ```

6. **Resolve `requestCustomQuote`** (HYBRID only):
   ```typescript
   const requestCustomQuote =
     service.pricingMode === 'HYBRID'
       ? formData.get('requestCustomQuote') === 'true'
       : undefined
   ```

7. **Resolve initial order state** using the freshly-fetched service:
   ```typescript
   const initialState = resolveOrderInitialState(service, requestCustomQuote)
   // src/domain/orders/pricing.ts
   ```

8. **Write `Order` + `ClientProfile` in a single transaction:**
   ```typescript
   const order = await prisma.$transaction(async (tx) => {
     const created = await tx.order.create({
       data: {
         clientId: session.user.id,
         labId: service.labId,
         serviceId: service.id,
         status: initialState.status,
         quantity: 1,  // Domain invariant: one sample per order creation (DL-quantity-001)
         notes,
         quotedPrice: initialState.quotedPrice,
         quotedAt: initialState.quotedAt,
       },
     })
     await tx.clientProfile.create({
       data: {
         orderId: created.id,
         name: parsed.data.name,
         email: parsed.data.email,
         phone: parsed.data.phone,
         organization: parsed.data.organization,
         address: parsed.data.address,
       },
     })
     return created
   })
   ```

9. **Redirect on success** — `redirect()` must be the last statement in the success branch.
   No `return` may precede it:
   ```typescript
   if (order.status === OrderStatus.PAYMENT_PENDING) {
     redirect(`/dashboard/orders/${order.id}/pay`)
   }
   redirect('/dashboard/client')
   ```
   > **Invariant**: Never `return` a value and then `redirect()`. Any `return` before
   > `redirect()` in a `useActionState` action suppresses the navigation silently.

**Must NOT**: Call PayMongo, call any external HTTP service, or set `Order.paymentIntentId`.

---

### Step 4 — `HybridToggle.tsx` (Client Component)

**`'use client'` at top.**

**Props:**
```typescript
type HybridToggleProps = {
  pricePerUnit: string | null  // from CreateOrderServiceDTO
}
```

**Internal state:**
```typescript
const [requestCustomQuote, setRequestCustomQuote] = useState(false)
```

**Renders:**
1. A checkbox input with `name="requestCustomQuote"` and `value={String(requestCustomQuote)}`
   — note: use a hidden `<input>` to reliably carry the boolean value in native `FormData`:
   ```tsx
   <input type="hidden" name="requestCustomQuote" value={String(requestCustomQuote)} />
   <input
     type="checkbox"
     id="requestCustomQuote"
     checked={requestCustomQuote}
     onChange={(e) => setRequestCustomQuote(e.target.checked)}
     className="mt-1"
   />
   ```
2. The conditional Alert block — if `requestCustomQuote`:
   ```tsx
   <Alert>
     <AlertDescription>
       <span className="text-green-600 font-medium">ℹ️ Custom quote</span>
       <p className="text-sm mt-1">You'll receive a custom quote from the lab.</p>
     </AlertDescription>
   </Alert>
   ```
   else:
   ```tsx
   <Alert>
     <AlertDescription>
       <span className="text-green-600 font-medium">✓ Instant booking</span>
       <p className="text-sm mt-1">
         You'll book at the reference price: {pricePerUnit ? `₱${pricePerUnit}` : 'N/A'}
       </p>
     </AlertDescription>
   </Alert>
   ```
3. **Exposes `requestCustomQuote` state upward** for submit button label via a callback prop
   or Context. Simplest: pass `onToggle: (val: boolean) => void` from `ui.tsx`.

**Why isolated**: The checkbox `onChange` triggers a local state update. If this lived in
`ui.tsx`, the entire form — including all uncontrolled inputs — would re-render on every
checkbox toggle.

---

### Step 5 — `ui.tsx` (Client Component)

**`'use client'` at top.**

**Props:**
```typescript
type OrderFormShellProps = {
  service: CreateOrderServiceDTO
}
```

**Hook setup:**
```typescript
const [state, formAction, isPending] = useActionState(createOrder, null)
const [isCustomQuote, setIsCustomQuote] = useState(false)
```

**Structure (preserves legacy Tailwind layout exactly):**

```tsx
<div className="min-h-screen bg-gray-50 py-8">
  <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
    {/* Back link — static <a> tag, no router.back() */}
    <div className="mb-6">
      <a href="/" className="...">← Back</a>
    </div>

    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
      {/* LEFT — Service Detail Card */}
      <Card> ... </Card>

      {/* RIGHT — Order Form Card */}
      <Card>
        <CardHeader>
          <CardTitle>Submit Test Request</CardTitle>
          <CardDescription>...</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="serviceId" value={service.id} />
            {/* fields */}
            {/* error display from state.errors */}
          </form>
        </CardContent>
      </Card>
    </div>
  </div>
</div>
```

**Field order in the form (matches legacy visual order):**

1. **Name** *(new field)*:
   ```tsx
   <label htmlFor="name">Full Name *</label>
   <input id="name" name="name" type="text" required minLength={2} maxLength={100}
     className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500" />
   {state?.errors?.name && <p className="text-sm text-red-600">{state.errors.name[0]}</p>}
   ```

2. **Sample Description** (with char counter — keep as uncontrolled; use `onInput` for counter
   or accept HTML5-only validation):
   ```tsx
   <textarea id="sampleDescription" name="sampleDescription" rows={3}
     minLength={10} required
     className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
     placeholder="Describe your sample (e.g., Coconut oil from batch #123)" />
   ```
   > The char counter in legacy used controlled state. For V2, use the HTML5 `minlength`
   > attribute for enforcement and omit the live counter, or add a small `defaultValue`-based
   > uncontrolled counter island. Keep the inline red validation message via browser's
   > constraint validation API.

3. **Special Instructions** (optional textarea)

4. **Pricing Mode Alerts** (static, driven by `service.pricingMode` prop):
   - `QUOTE_REQUIRED`: render `<Alert>` — "Custom quote required" — inline, no toggle
   - `FIXED`: render `<Alert>` — "Fixed rate service at ₱{service.pricePerUnit}"
   - `HYBRID`: render `<HybridToggle pricePerUnit={service.pricePerUnit} onToggle={setIsCustomQuote} />`

5. **Contact grid** (`grid sm:grid-cols-2 gap-4`): Email + Phone inputs

6. **Organization** (optional)

7. **Address** *(collapsed from 3 fields to 1)*:
   ```tsx
   <label htmlFor="address">Shipping Address</label>
   <textarea id="address" name="address" rows={2}
     placeholder="Street, City, Postal Code (e.g., 123 Rizal Ave, Makati, 1200)"
     className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500" />
   ```

8. **Submit button** — dynamic label driven by `service.pricingMode` and `isCustomQuote`:
   ```tsx
   <Button type="submit" className="w-full" disabled={isPending}>
     {isPending ? 'Submitting...' :
       service.pricingMode === 'QUOTE_REQUIRED' ? 'Submit RFQ' :
       service.pricingMode === 'HYBRID' && isCustomQuote ? 'Submit RFQ' :
       service.pricingMode === 'HYBRID' ? `Book Service — ₱${service.pricePerUnit ?? ''}` :
       `Book Service — ₱${service.pricePerUnit ?? ''}`
     }
   </Button>
   ```

9. **Global error message** (shown when `state?.message` is set):
   ```tsx
   {state?.message && (
     <Alert variant="destructive">
       <AlertDescription>{state.message}</AlertDescription>
     </Alert>
   )}
   ```

**Service Detail Card (left, read-only):**

Port from legacy lines 164–219 of `_legacy_v1/app/order/[serviceId]/page.tsx`. Keep:
- Service name (`text-xl`), lab name as `CardDescription`
- Description and sample requirements sections (`font-medium text-gray-900` / `text-gray-700`)
- Price display conditional on `pricingMode` (`text-lg font-semibold text-green-600` for FIXED)
- Lab location — `(service.lab.location as { city?: string })?.city ?? 'Metro Manila'`
- Accreditations — `px-2 py-1 bg-green-100 text-green-800 rounded text-sm`

**Omit** from service card: `turnaroundDays` and `sampleRequirements` — not in V2 schema.

---

## Acceptance Criteria

All must pass before the slice is considered done:

| # | Criterion | How to verify |
|---|---|---|
| AC-1 | `npx tsc --noEmit` exits 0 | Run tsc |
| AC-2 | `npx eslint src/features/orders/` exits 0 | No domain boundary violations |
| AC-3 | No `Decimal` object appears in any Client Component prop | Grep for `Decimal` in `ui.tsx` and `HybridToggle.tsx` — must be absent |
| AC-4 | FIXED service → redirects to `/dashboard/orders/[orderId]/pay` | Manual: submit order for a FIXED service |
| AC-5 | QUOTE_REQUIRED service → redirects to `/dashboard/client` | Manual: submit order for a QUOTE_REQUIRED service |
| AC-6 | HYBRID + checkbox unchecked → `PAYMENT_PENDING`, redirects to `/pay` | Manual: submit HYBRID without toggling |
| AC-7 | HYBRID + checkbox checked → `QUOTE_REQUESTED`, redirects to `/dashboard/client` | Manual: submit HYBRID with toggle on |
| AC-8 | Invalid phone number → server returns field error on `phone` | Submit form with `abc` as phone |
| AC-9 | `name` shorter than 2 chars → server returns field error on `name` | Submit form with `A` as name |
| AC-10 | `sampleDescription` < 10 chars → browser blocks submission | HTML5 minlength prevents submit |
| AC-11 | `ClientProfile` row is created (not upserted) for each order | Check DB: `SELECT * FROM client_profiles WHERE order_id = ?` |
| AC-12 | `Order.quantity` is always `1` in the DB | Check DB row after submit |
| AC-13 | `Order.notes` contains both sampleDescription and specialInstructions joined by `\n\n` | Check DB row when both fields are filled |
| AC-14 | Changing `pricingMode` in DB between page load and submit does not corrupt order status | TOCTOU test: change service pricingMode in DB after loading page, submit — verify action uses fresh fetch |

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `redirect()` suppressed by accidental `return` in action | Medium | Linter comment on action; AC-4–7 catch it |
| `Prisma.JsonValue` for `lab.location` causes type error when accessing `.city` | High | Use `as { city?: string }` type assertion at access site; document in comment |
| `useActionState` + `redirect()` incompatibility in older Next.js versions | Low | Requires Next.js 14.2+; verify in `package.json` |
| HYBRID checkbox value not in `FormData` when unchecked | High | Use hidden `<input type="hidden">` carrying `String(requestCustomQuote)` — do not rely on checkbox presence in FormData |
| Missing `name` field caught only at submit, not at render | Low | Add field prominently above email; AC-9 validates |
| `turnaroundDays` / `sampleRequirements` absent from V2 schema | Confirmed | Omit from UI per this plan; revisit in a schema migration if needed |

---

## File Reference Index

| Referenced file | Used in step |
|---|---|
| `src/domain/orders/client-details.ts` | Step 3 (action validation) |
| `src/domain/orders/pricing.ts` | Step 3 (resolveOrderInitialState) |
| `src/domain/orders/state-machine.ts` | Background — confirms PAYMENT_PENDING and QUOTE_REQUESTED are valid initial statuses |
| `prisma/schema.prisma` lines 150–168, 173–202, 206–219 | Step 2 (DTO shape), Step 3 (transaction write) |
| `src/_legacy_v1/app/order/[serviceId]/page.tsx` lines 153–440 | Step 5 (JSX + Tailwind) |
| `src/_legacy_v1/components/ui/alert.tsx` | Alert variants — `default`, `destructive`, `success` |
| `src/_legacy_v1/components/ui/button.tsx` | Button variants — `default`, `outline` |
| `src/_legacy_v1/components/ui/card.tsx` | Card, CardHeader, CardTitle, CardDescription, CardContent |
