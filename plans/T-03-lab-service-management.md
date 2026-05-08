# T-03 — Lab Service Management

**Branch:** `feat/T03-lab-service-management`
**Plan status:** ready for implementation
**Depends on:** T-02 (Lab record + LAB_ADMIN role exist before any service can be created)

---

## Context snapshot

| What | Where | State |
|------|-------|-------|
| `LabService` model | `prisma/schema.prisma` | `labId`, `name`, `description?`, `category: ServiceCategory`, `pricingMode: PricingMode`, `pricePerUnit: Decimal(12,2)?`, `unit?`, `isActive: Boolean @default(true)` |
| `PricingMode` enum | `prisma/schema.prisma` | `QUOTE_REQUIRED`, `FIXED`, `HYBRID` |
| `ServiceCategory` enum | `prisma/schema.prisma` | `CHEMICAL_TESTING`, `BIOLOGICAL_TESTING`, `PHYSICAL_TESTING`, `ENVIRONMENTAL_TESTING`, `CALIBRATION`, `CERTIFICATION` |
| Lab ownership | `prisma/schema.prisma` | `Lab.ownerId` — no `@@unique`; one-lab-per-user enforced by T-02 action |
| Lab dashboard guard | `src/features/labs/dashboard/page.tsx:42` | `labs.length !== 1` → `notFound()` — service management must confirm one lab before writing |
| Feature dir | `src/features/labs/service-management/` | does not exist yet |

---

## Critical invariants

1. **`pricePerUnit` is required for `FIXED` and `HYBRID`, forbidden for `QUOTE_REQUIRED`.** The Zod schema must use `.superRefine` to enforce this cross-field constraint. A `FIXED` service with no price would break checkout.

2. **Ownership check is mandatory on every mutating action.** The action must confirm `Lab.ownerId === session.user.id` before any write. A missing check would let any LAB_ADMIN modify another lab's services.

3. **`isActive` toggle is a soft-delete, not a hard delete.** No `LabService` row is ever deleted — only `isActive` flipped to `false`. Orders already referencing a deactivated service must not be broken.

4. **`labId` is sourced from the DB, not from the client.** The form never sends `labId`; the action resolves it via `prisma.lab.findFirst({ where: { ownerId: session.user.id } })`. This prevents a client from forging a `labId`.

5. **`pricePerUnit` is a `Decimal` in Prisma.** Pass as a string from Zod (parsed from `formData`), not a JS float, to avoid floating-point precision loss. Zod's `z.string()` → `z.coerce.number()` then convert to string for Prisma is acceptable; or pass directly as a string.

---

## Acceptance criteria

- [ ] LAB_ADMIN can create a FIXED-priced service (name, category, pricePerUnit, unit required)
- [ ] LAB_ADMIN can create a QUOTE_REQUIRED service (no price fields)
- [ ] LAB_ADMIN can edit any of their own services
- [ ] LAB_ADMIN can toggle `isActive` on a service (deactivate / reactivate)
- [ ] Creating a FIXED service without `pricePerUnit` returns a validation error
- [ ] Attempting to write to another lab's service returns an authorization error
- [ ] `npx tsc --noEmit` exits 0
- [ ] `npm test -- --run` exits 0
- [ ] `npx eslint src/` exits 0

---

## Implementation steps

### Step 1 — Server Action: `src/features/labs/service-management/action.ts`

```ts
'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { PricingMode, ServiceCategory } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'

const serviceSchema = z
  .object({
    name: z.string().min(2).max(100),
    description: z.string().max(500).optional(),
    category: z.nativeEnum(ServiceCategory),
    pricingMode: z.nativeEnum(PricingMode),
    pricePerUnit: z.string().optional(),
    unit: z.string().max(50).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      (data.pricingMode === PricingMode.FIXED ||
        data.pricingMode === PricingMode.HYBRID) &&
      (!data.pricePerUnit || isNaN(parseFloat(data.pricePerUnit)))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pricePerUnit'],
        message: 'Price is required for FIXED and HYBRID services.',
      })
    }
  })

export type ServiceFormState = {
  errors?: Record<string, string[]>
  message?: string
}

async function resolveOwnedLab(userId: string) {
  const lab = await prisma.lab.findFirst({ where: { ownerId: userId } })
  return lab
}

export async function createService(
  _prev: ServiceFormState,
  formData: FormData,
): Promise<ServiceFormState> {
  const session = await auth()
  if (!session?.user.id) redirect('/auth/signin')

  const parsed = serviceSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') || undefined,
    category: formData.get('category'),
    pricingMode: formData.get('pricingMode'),
    pricePerUnit: formData.get('pricePerUnit') || undefined,
    unit: formData.get('unit') || undefined,
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const lab = await resolveOwnedLab(session.user.id)
  if (!lab) return { message: 'No lab found for this account.' }

  const { name, description, category, pricingMode, pricePerUnit, unit } = parsed.data

  try {
    await prisma.labService.create({
      data: {
        labId: lab.id,
        name,
        description,
        category,
        pricingMode,
        pricePerUnit: pricePerUnit ?? null,
        unit: unit ?? null,
      },
    })
  } catch {
    return { message: 'Failed to create service. Please try again.' }
  }

  redirect('/dashboard/lab')
}

export async function updateService(
  _prev: ServiceFormState,
  formData: FormData,
): Promise<ServiceFormState> {
  const session = await auth()
  if (!session?.user.id) redirect('/auth/signin')

  const serviceId = formData.get('serviceId')
  if (typeof serviceId !== 'string' || !serviceId) {
    return { message: 'Invalid service ID.' }
  }

  const parsed = serviceSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') || undefined,
    category: formData.get('category'),
    pricingMode: formData.get('pricingMode'),
    pricePerUnit: formData.get('pricePerUnit') || undefined,
    unit: formData.get('unit') || undefined,
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const lab = await resolveOwnedLab(session.user.id)
  if (!lab) return { message: 'No lab found for this account.' }

  const service = await prisma.labService.findUnique({ where: { id: serviceId } })
  if (!service || service.labId !== lab.id) {
    return { message: 'Service not found or access denied.' }
  }

  const { name, description, category, pricingMode, pricePerUnit, unit } = parsed.data

  try {
    await prisma.labService.update({
      where: { id: serviceId },
      data: {
        name,
        description,
        category,
        pricingMode,
        pricePerUnit: pricePerUnit ?? null,
        unit: unit ?? null,
      },
    })
  } catch {
    return { message: 'Failed to update service. Please try again.' }
  }

  redirect('/dashboard/lab')
}

export async function toggleServiceActive(
  _prev: ServiceFormState,
  formData: FormData,
): Promise<ServiceFormState> {
  const session = await auth()
  if (!session?.user.id) redirect('/auth/signin')

  const serviceId = formData.get('serviceId')
  if (typeof serviceId !== 'string' || !serviceId) {
    return { message: 'Invalid service ID.' }
  }

  const lab = await resolveOwnedLab(session.user.id)
  if (!lab) return { message: 'No lab found for this account.' }

  const service = await prisma.labService.findUnique({ where: { id: serviceId } })
  if (!service || service.labId !== lab.id) {
    return { message: 'Service not found or access denied.' }
  }

  try {
    await prisma.labService.update({
      where: { id: serviceId },
      data: { isActive: !service.isActive },
    })
  } catch {
    return { message: 'Failed to update service. Please try again.' }
  }

  redirect('/dashboard/lab')
}
```

---

### Step 2 — UI: `src/features/labs/service-management/ui.tsx`

```tsx
'use client'

import { useActionState } from 'react'
import { PricingMode, ServiceCategory } from '@prisma/client'
import {
  createService,
  updateService,
  toggleServiceActive,
  type ServiceFormState,
} from './action'

const initialState: ServiceFormState = {}

export function CreateServiceForm() {
  const [state, formAction, pending] = useActionState(createService, initialState)
  return <ServiceForm state={state} formAction={formAction} pending={pending} />
}

export function EditServiceForm({ serviceId, defaults }: {
  serviceId: string
  defaults: {
    name: string
    description?: string
    category: ServiceCategory
    pricingMode: PricingMode
    pricePerUnit?: string
    unit?: string
  }
}) {
  const [state, formAction, pending] = useActionState(updateService, initialState)
  return (
    <ServiceForm
      state={state}
      formAction={formAction}
      pending={pending}
      serviceId={serviceId}
      defaults={defaults}
    />
  )
}

export function ToggleActiveForm({ serviceId, isActive }: { serviceId: string; isActive: boolean }) {
  const [state, formAction, pending] = useActionState(toggleServiceActive, initialState)
  return (
    <form action={formAction}>
      <input type="hidden" name="serviceId" value={serviceId} />
      {state.message && <p role="alert">{state.message}</p>}
      <button type="submit" disabled={pending}>
        {pending ? '…' : isActive ? 'Deactivate' : 'Reactivate'}
      </button>
    </form>
  )
}

function ServiceForm({
  state,
  formAction,
  pending,
  serviceId,
  defaults,
}: {
  state: ServiceFormState
  formAction: (payload: FormData) => void
  pending: boolean
  serviceId?: string
  defaults?: {
    name?: string
    description?: string
    category?: ServiceCategory
    pricingMode?: PricingMode
    pricePerUnit?: string
    unit?: string
  }
}) {
  return (
    <form action={formAction}>
      {serviceId && <input type="hidden" name="serviceId" value={serviceId} />}
      {state.message && <p role="alert">{state.message}</p>}

      <div>
        <label htmlFor="name">Service name</label>
        <input id="name" name="name" defaultValue={defaults?.name} required />
        {state.errors?.name && <p>{state.errors.name[0]}</p>}
      </div>

      <div>
        <label htmlFor="description">Description</label>
        <textarea id="description" name="description" defaultValue={defaults?.description} />
        {state.errors?.description && <p>{state.errors.description[0]}</p>}
      </div>

      <div>
        <label htmlFor="category">Category</label>
        <select id="category" name="category" defaultValue={defaults?.category} required>
          {Object.values(ServiceCategory).map((c) => (
            <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
          ))}
        </select>
        {state.errors?.category && <p>{state.errors.category[0]}</p>}
      </div>

      <div>
        <label htmlFor="pricingMode">Pricing mode</label>
        <select id="pricingMode" name="pricingMode" defaultValue={defaults?.pricingMode} required>
          {Object.values(PricingMode).map((m) => (
            <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>
          ))}
        </select>
        {state.errors?.pricingMode && <p>{state.errors.pricingMode[0]}</p>}
      </div>

      <div>
        <label htmlFor="pricePerUnit">Price per unit</label>
        <input
          id="pricePerUnit"
          name="pricePerUnit"
          type="number"
          step="0.01"
          min="0"
          defaultValue={defaults?.pricePerUnit}
        />
        {state.errors?.pricePerUnit && <p>{state.errors.pricePerUnit[0]}</p>}
      </div>

      <div>
        <label htmlFor="unit">Unit</label>
        <input id="unit" name="unit" defaultValue={defaults?.unit} />
        {state.errors?.unit && <p>{state.errors.unit[0]}</p>}
      </div>

      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : serviceId ? 'Save changes' : 'Create service'}
      </button>
    </form>
  )
}
```

---

### Step 3 — RSC page: `src/features/labs/service-management/page.tsx`

```tsx
import { notFound, redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { CreateServiceForm, EditServiceForm, ToggleActiveForm } from './ui'

export default async function ServiceManagementPage() {
  const session = await auth()
  if (!session?.user.id || session.user.role !== 'LAB_ADMIN') redirect('/auth/signin')

  const lab = await prisma.lab.findFirst({ where: { ownerId: session.user.id } })
  if (!lab) notFound()

  const services = await prisma.labService.findMany({
    where: { labId: lab.id },
    orderBy: { createdAt: 'asc' },
  })

  return (
    <main>
      <h1>Manage services</h1>

      <section>
        <h2>Add a service</h2>
        <CreateServiceForm />
      </section>

      <section>
        <h2>Your services</h2>
        {services.length === 0 && <p>No services yet.</p>}
        {services.map((s) => (
          <div key={s.id}>
            <h3>{s.name} {!s.isActive && '(inactive)'}</h3>
            <p>{s.category.replace(/_/g, ' ')} — {s.pricingMode.replace(/_/g, ' ')}</p>
            <EditServiceForm
              serviceId={s.id}
              defaults={{
                name: s.name,
                description: s.description ?? undefined,
                category: s.category,
                pricingMode: s.pricingMode,
                pricePerUnit: s.pricePerUnit?.toString() ?? undefined,
                unit: s.unit ?? undefined,
              }}
            />
            <ToggleActiveForm serviceId={s.id} isActive={s.isActive} />
          </div>
        ))}
      </section>
    </main>
  )
}
```

---

### Step 4 — App router mount: `src/app/labs/service-management/page.tsx`

```tsx
export { default } from '@/features/labs/service-management/page'
```

---

## Files checklist

| File | Action |
|------|--------|
| `src/features/labs/service-management/action.ts` | create — three Server Actions: createService, updateService, toggleServiceActive |
| `src/features/labs/service-management/ui.tsx` | create — CreateServiceForm, EditServiceForm, ToggleActiveForm |
| `src/features/labs/service-management/page.tsx` | create — RSC: auth guard, lab lookup, service list |
| `src/app/labs/service-management/page.tsx` | create — VSA re-export |
| `prisma/schema.prisma` | **no changes** |

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| FIXED/HYBRID service created without price | `superRefine` cross-field validation in Zod schema |
| LAB_ADMIN writes to another lab's service | Ownership check: `service.labId !== lab.id` before every mutating DB call |
| `labId` forged by client | `labId` resolved server-side from `session.user.id`; never read from formData |
| Hard-delete breaks existing orders | Only `isActive` toggle; no delete action exposed |
| `pricePerUnit` float precision loss | Passed as string to Prisma `Decimal` field |
| Prisma error on create/update | try/catch in each action; returns `{ message }` |
