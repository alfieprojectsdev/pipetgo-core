# T-01 — Auth Providers: Google OAuth via NextAuth v5-beta

**Branch:** `feat/T01-auth-providers`
**Plan status:** ready for implementation
**Depends on:** none (first unblocked slice)

---

## Context snapshot

| What | Where | State |
|------|-------|-------|
| NextAuth config | `src/lib/auth.ts:15` | `providers: []`, no adapter, JWT callbacks in place |
| Session type augmentation | `src/lib/auth.ts:3–12` | `session.user.id` and `session.user.role` typed |
| PrismaAdapter | not installed | `@auth/prisma-adapter` absent from `package.json` |
| Route handler | `src/app/api/auth/[...nextauth]/` | **directory does not exist** |
| Root layout | `src/app/layout.tsx` | **does not exist** (Next.js requires one) |
| Sign-in page | `src/app/auth/signin/` | **does not exist** — dashboards redirect to `/auth/signin` |
| Prisma schema | `prisma/schema.prisma` | `User`, `Account`, `VerificationToken` present — JWT strategy fully covered |
| Prisma singleton | `src/lib/prisma.ts:8` | `globalThis` cache pattern — correct for serverless |

---

## Critical invariants (must be preserved)

1. **JWT strategy must be explicitly declared.** With `PrismaAdapter` present, Auth.js v5 defaults to `strategy: 'database'`. Under database strategy, the JWT `token.role` callback never fires, and no `Session` model exists in schema. Both would cause runtime failure. Set `session: { strategy: 'jwt' }` explicitly in the NextAuth config.

2. **`AdapterUser` must be augmented alongside `User`.** The `jwt` callback receives an `AdapterUser` type (not `User`) on first sign-in. The `'role' in user` guard works at runtime but TypeScript strict mode requires `AdapterUser` to be augmented with `role: UserRole`. Augment `@auth/core/adapters` in `src/lib/auth.ts`.

3. **`session.user.role` must never fall back silently.** The fallback `?? 'CLIENT'` masks token-seeding failures — a LAB_ADMIN whose JWT callback misfired silently downgrades. If `token.role` is absent after first sign-in, it is a bug. Throw an error rather than default to a role.

4. **`signIn('google')` must be called from a `'use server'` function bound to `<form action={...}>`.** It cannot be an `onClick` handler in an RSC. Auth.js v5 uses a redirect response that must propagate from a Server Action.

5. **`trustHost: true` required** on Neon/serverless environments where requests pass through a proxy. Omitting it causes `UntrustedHost` errors at runtime.

---

## Acceptance criteria

- [ ] A CLIENT user can sign in with Google and land on `/dashboard/client`
- [ ] A LAB_ADMIN user can sign in with Google and land on `/dashboard/lab`
- [ ] An unauthenticated request to `/dashboard/client` or `/dashboard/lab` redirects to `/auth/signin`
- [ ] `npx tsc --noEmit` exits 0
- [ ] `npm test -- --run` exits 0 (existing webhook tests must not regress)
- [ ] `npx eslint src/` exits 0 (no new domain boundary violations)

---

## Implementation steps

### Step 0 — Install dependencies

```bash
npm install @auth/prisma-adapter
```

`@auth/prisma-adapter` is a separate package from `next-auth` and is not bundled.

---

### Step 1 — Rewrite `src/lib/auth.ts`

Replace the entire file:

```ts
import NextAuth, { type DefaultSession } from 'next-auth'
import Google from 'next-auth/providers/google'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: string
    } & DefaultSession['user']
  }
  interface User {
    role?: UserRole
  }
}

declare module '@auth/core/adapters' {
  interface AdapterUser {
    role: UserRole
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [Google()],
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: {
    signIn: '/auth/signin',
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.role = user.role ?? UserRole.CLIENT
      }
      return token
    },
    session({ session, token }) {
      if (!token.role) {
        throw new Error('JWT token missing role — auth misconfiguration')
      }
      return {
        ...session,
        user: {
          ...session.user,
          id: token.sub ?? '',
          role: token.role as string,
        },
      }
    },
  },
})
```

**Why each change:**
- `session: { strategy: 'jwt' }` — overrides the adapter default (`'database'`). Without it, the `jwt` callback never fires and `LabWallet` credits break silently.
- `trustHost: true` — required for Neon and any reverse proxy. Prevents `UntrustedHost` errors at runtime.
- `pages: { signIn: '/auth/signin' }` — aligns Auth.js redirects with the existing dashboard guard (`redirect('/auth/signin')` at `src/features/clients/dashboard/page.tsx:40`).
- `AdapterUser` augmentation — the `user` parameter in the `jwt` callback is `AdapterUser` on first sign-in. Augmenting removes the need for a type cast and makes the guard type-safe.
- Error throw instead of `?? 'CLIENT'` fallback — `token.role` should always be set after the `jwt` callback fires. A missing role on subsequent requests is a bug, not a normal path.

---

### Step 2 — Create `src/app/api/auth/[...nextauth]/route.ts`

```ts
import { handlers } from '@/lib/auth'
export const { GET, POST } = handlers
```

This is the Next.js App Router mount point for all Auth.js endpoints (`/api/auth/signin`, `/api/auth/callback/google`, `/api/auth/signout`, `/api/auth/session`).

---

### Step 3 — Create `src/app/layout.tsx`

Next.js 14 App Router requires a root layout. Create a minimal one:

```tsx
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'PipetGo',
  description: 'Lab testing marketplace',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
```

No `SessionProvider` wrapper needed. All auth gating is RSC-based via `auth()`. If a future client component needs `useSession`, it must add `SessionProvider` at that point.

---

### Step 4 — Create the sign-in feature slice

Create `src/features/auth/signin/page.tsx`:

```tsx
import { signIn } from '@/lib/auth'

export default function SignInPage() {
  return (
    <main>
      <h1>Sign in to PipetGo</h1>
      <form
        action={async () => {
          'use server'
          await signIn('google', { redirectTo: '/dashboard/client' })
        }}
      >
        <button type="submit">Sign in with Google</button>
      </form>
    </main>
  )
}
```

**Notes:**
- `'use server'` must be inside the function body, not at the top of the file, because the file is an RSC (no `'use client'`).
- `redirectTo: '/dashboard/client'` is the default after sign-in. Dashboard guards then enforce role-specific routing. A LAB_ADMIN who lands on `/dashboard/client` is immediately redirected to `/auth/signin` — a minor UX limitation acceptable for this phase. Role-aware `redirectTo` can be added in T-02 or a future UX ticket.
- Do not add styling beyond structural HTML. This is a skeleton; design passes happen separately.

Create `src/app/auth/signin/page.tsx` (re-export per VSA boundary rules — ADR-001):

```tsx
export { default } from '@/features/auth/signin/page'
```

---

### Step 5 — Environment variables

Add to `.env` (never commit — already in `.gitignore`):

```
# NextAuth — required
AUTH_SECRET=<generate: openssl rand -base64 32>

# Google OAuth — from Google Cloud Console
AUTH_GOOGLE_ID=<your-client-id>.apps.googleusercontent.com
AUTH_GOOGLE_SECRET=<your-client-secret>
```

**Google Cloud Console setup (manual, out of code scope):**
1. Create OAuth 2.0 credentials → Web application.
2. Add authorized redirect URIs:
   - `http://localhost:3000/api/auth/callback/google` (development)
   - `https://<production-domain>/api/auth/callback/google` (production)
3. Note: the path is `/api/auth/callback/google`, not `/api/auth/[...nextauth]/callback/google`.

---

## Verification steps

```bash
# 1. Type check — must exit 0
npx tsc --noEmit

# 2. Lint — must exit 0
npx eslint src/

# 3. Tests — webhook tests must not regress
npm test -- --run

# 4. Dev server — manual sign-in flow
npm run dev
# Navigate to http://localhost:3000/dashboard/client → redirects to /auth/signin
# Click "Sign in with Google" → Google OAuth flow → lands on /dashboard/client
# For LAB_ADMIN: set user.role = LAB_ADMIN in DB → sign in → lands on /dashboard/lab
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Adapter default flips strategy to `database` — jwt callback silences | `session: { strategy: 'jwt' }` explicit in config |
| `token.role` missing on subsequent requests masks seeding bug | Throw in `session` callback instead of defaulting |
| `UntrustedHost` on Neon/proxy | `trustHost: true` in config |
| Google Console redirect URI mismatch | Document exact URI format; localhost + production both needed |
| `@auth/prisma-adapter` not in `package.json` | Step 0 installs it |
| No root layout — Next.js won't serve any route | Step 3 creates minimal layout |
| `signIn()` called from client-side onClick — won't work | Step 4 uses form action + `'use server'` |
| LAB_ADMIN lands on `/dashboard/client` after sign-in | Documented as phase-1 limitation; role-aware redirect is a future UX ticket |

---

## Files checklist

| File | Action |
|------|--------|
| `package.json` | add `@auth/prisma-adapter` dependency |
| `src/lib/auth.ts` | rewrite — adapter, Google, JWT strategy, trustHost, pages, AdapterUser augment |
| `src/app/api/auth/[...nextauth]/route.ts` | create — handlers export |
| `src/app/layout.tsx` | create — minimal root layout |
| `src/features/auth/signin/page.tsx` | create — sign-in page with Server Action |
| `src/app/auth/signin/page.tsx` | create — re-export per VSA rules |
| `.env` | add `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` (manual, not committed) |
| `prisma/schema.prisma` | **no changes** — schema already complete for JWT+OAuth |
