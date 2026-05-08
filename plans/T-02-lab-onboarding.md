# T-02 — Lab Onboarding

**Branch:** `feat/T02-lab-onboarding`
**Plan status:** ready for implementation
**Depends on:** T-01 (auth session, `auth()`, `UserRole`)

---

## Context snapshot

| What | Where | State |
|------|-------|-------|
| `Lab` model | `prisma/schema.prisma:81` | `ownerId`, `name`, `description`, `location: Json?`, `certifications`, `isVerified`, `@@index([ownerId])` — no `@@unique` on ownerId |
| `User.role` | `prisma/schema.prisma:87` | `UserRole @default(CLIENT)` — needs to be set to `LAB_ADMIN` on registration |
| Lab dashboard | `src/features/labs/dashboard/page.tsx:42` | `notFound()` if `labs.length !== 1` — onboarding must create exactly one lab per user |
| App router | `src/app/dashboard/lab/page.tsx` | Re-export only — no changes needed |
| Auth pattern | `src/features/clients/dashboard/page.tsx` | `auth()` → role guard → redirect |
| Sign-in redirect | `src/features/auth/signin/page.tsx` | `redirectTo: '/dashboard/client'` — onboarding redirects to `/dashboard/lab` post-registration |

---

## Critical invariants

1. **One lab per user, enforced in the action.** Schema has no `@@unique` on `Lab.ownerId`. The action must check for an existing lab and return a duplicate error rather than creating a second one. The dashboard's `labs.length !== 1` guard will `notFound()` if two labs exist.

2. **`User.role` must be set to `LAB_ADMIN` atomically with lab creation.** Both writes must happen inside a single `prisma.$transaction`. A committed `Lab` row with a `CLIENT` role user leaves the system in a broken state (lab dashboard redirects to sign-in).

3. **Only authenticated users can onboard.** The page RSC must call `auth()` and redirect to `/auth/signin` if no session exists.

4. **`location` is `Json?` in the schema.** For phase 1, store as `{ city: string, country: string }`. Do not model as a nested object type in Prisma — it is already `Json`.

5. **No `certifications` in phase 1.** The field is `String[]` in the schema and defaults to `[]` — omit from the form; the action passes `certifications: []`.

---

## Acceptance criteria

- [ ] A signed-in user can submit the onboarding form and is redirected to `/dashboard/lab`
- [ ] Submitting the form a second time returns a user-visible error ("Lab already registered")
- [ ] An unauthenticated request to `/labs/onboarding` redirects to `/auth/signin`
- [ ] `User.role` is `LAB_ADMIN` in the DB after successful registration
- [ ] `npx tsc --noEmit` exits 0
- [ ] `npm test -- --run` exits 0
- [ ] `npx eslint src/` exits 0 (no new domain boundary violations)

---

## Implementation steps

### Step 1 — Create the Server Action: `src/features/labs/onboarding/action.ts`

```ts
'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'

const onboardingSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  city: z.string().min(1).max(100),
  country: z.string().min(1).max(100),
})

export type OnboardingState = {
  errors?: Partial<Record<keyof z.infer<typeof onboardingSchema>, string[]>>
  message?: string
}

export async function registerLab(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const session = await auth()
  if (!session?.user.id) redirect('/auth/signin')

  const parsed = onboardingSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') || undefined,
    city: formData.get('city'),
    country: formData.get('country'),
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const existing = await prisma.lab.findFirst({
    where: { ownerId: session.user.id },
  })
  if (existing) {
    return { message: 'Lab already registered for this account.' }
  }

  const { name, description, city, country } = parsed.data

  await prisma.$transaction([
    prisma.lab.create({
      data: {
        ownerId: session.user.id,
        name,
        description,
        location: { city, country },
        certifications: [],
      },
    }),
    prisma.user.update({
      where: { id: session.user.id },
      data: { role: UserRole.LAB_ADMIN },
    }),
  ])

  redirect('/dashboard/lab')
}
```

---

### Step 2 — Create the form UI: `src/features/labs/onboarding/ui.tsx`

```tsx
'use client'

import { useActionState } from 'react'
import { registerLab, type OnboardingState } from './action'

const initialState: OnboardingState = {}

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(registerLab, initialState)

  return (
    <form action={formAction}>
      {state.message && <p role="alert">{state.message}</p>}

      <div>
        <label htmlFor="name">Lab name</label>
        <input id="name" name="name" required />
        {state.errors?.name && <p>{state.errors.name[0]}</p>}
      </div>

      <div>
        <label htmlFor="description">Description</label>
        <textarea id="description" name="description" />
        {state.errors?.description && <p>{state.errors.description[0]}</p>}
      </div>

      <div>
        <label htmlFor="city">City</label>
        <input id="city" name="city" required />
        {state.errors?.city && <p>{state.errors.city[0]}</p>}
      </div>

      <div>
        <label htmlFor="country">Country</label>
        <input id="country" name="country" required />
        {state.errors?.country && <p>{state.errors.country[0]}</p>}
      </div>

      <button type="submit" disabled={pending}>
        {pending ? 'Registering…' : 'Register lab'}
      </button>
    </form>
  )
}
```

---

### Step 3 — Create the RSC page: `src/features/labs/onboarding/page.tsx`

```tsx
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { OnboardingForm } from './ui'

export default async function LabOnboardingPage() {
  const session = await auth()
  if (!session?.user.id) redirect('/auth/signin')

  return (
    <main>
      <h1>Register your lab</h1>
      <OnboardingForm />
    </main>
  )
}
```

---

### Step 4 — Create the app router mount: `src/app/labs/onboarding/page.tsx`

```tsx
export { default } from '@/features/labs/onboarding/page'
```

---

## Files checklist

| File | Action |
|------|--------|
| `src/features/labs/onboarding/action.ts` | create — Server Action with Zod validation + `$transaction` |
| `src/features/labs/onboarding/ui.tsx` | create — `useActionState` form client component |
| `src/features/labs/onboarding/page.tsx` | create — RSC auth guard + form render |
| `src/app/labs/onboarding/page.tsx` | create — VSA re-export |
| `prisma/schema.prisma` | **no changes** — schema already covers `Lab`, `User.role` |

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Two labs created for one user (race condition on double-submit) | `findFirst` check before create; future: DB unique constraint or idempotency key (T-16) |
| `User.role` updated but `Lab` create fails mid-transaction | `prisma.$transaction([...])` — both writes are atomic |
| `location` stored as arbitrary JSON — shape drift | Phase-1 shape documented here; T-15 or a future migration can add a structured `address` table |
| Lab dashboard `notFound()` on zero labs after redirect | The redirect to `/dashboard/lab` happens after the `$transaction` commits — lab always exists before redirect fires |
