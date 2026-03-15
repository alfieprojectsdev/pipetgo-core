### 1. Core Stack & Library Choices

I have selected libraries that prioritize type safety and minimalist boilerplate, aligning with the "First Principles" approach.

* **Framework:** Next.js 14+ (App Router).
* **Language:** TypeScript (Strict Mode).
* **Database & ORM:** PostgreSQL (Neon.tech) + Prisma.
* **Auth:** NextAuth.js (v5/Beta for better Server Action support).
* **Validation:** Zod (Single source of truth for UI and API).
* **Styling:** Tailwind CSS + Shadcn/UI (Copy-paste components, no heavy dependencies).
* **State Management:** URL State (`nuqs`) + React Server Actions (No Redux/Zustand needed).
* **Payments:** PayMongo SDK (or raw `fetch` for the lightweight wrapper we built).
* **Notifications:** `sonner` (Toasts) + React Email (for lab/client alerts).

---

### 2. The V2 Folder Structure

This structure implements the **Vertical Slice** pattern. Notice how `features/` is the heart of the application, while `app/` remains a thin routing shell.

```text
pipetgo-v2/
├── src/
│   ├── app/                 # Next.js App Router (Routing Shell only)
│   │   ├── (auth)/          # Grouped routes for login/register
│   │   ├── (dashboard)/     # Layouts for Client/Lab/Admin
│   │   │   └── orders/
│   │   │       └── [id]/    # Page pulls from multiple feature slices
│   │   └── api/             # Webhooks and external integrations only
│   │
│   ├── features/            # THE CORE: Domain-specific Vertical Slices
│   │   ├── auth/            # Auth components, session logic, RBAC middleware
│   │   ├── orders/          # Slices: list-orders, create-order, order-timeline
│   │   │   └── approve-quote/
│   │   │       ├── action.ts
│   │   │       ├── schema.ts
│   │   │       └── ui.tsx
│   │   ├── payment/         # Slices: checkout-session, webhooks, payouts
│   │   └── services/        # Slices: catalog, search, lab-profile
│   │
│   ├── components/          # Truly generic UI (Button, Input, Card)
│   ├── lib/                 # Shared infrastructure (Prisma client, Auth config)
│   └── styles/              # Global CSS
├── prisma/
│   └── schema.prisma        # The V2 schema we defined
├── .env                     # Secrets (PayMongo, Neon, NextAuth)
└── next.config.js

```

---

### 3. Implementation Roadmap (First 48 Hours)

To get V2 from zero to a working "Payment-Ready" state, follow this sequence:

**Step 1: The Foundation**

1. `npx create-next-app@latest pipetgo-v2` (Tailwind, App Router, Src directory).
2. Install core deps: `npm i @prisma/client zod next-auth@beta sonner lucide-react`.
3. Initialize Prisma and push the **V2 Schema** we drafted to a new Neon branch.

**Step 2: Shared Auth Slice**

1. Set up `src/lib/auth.ts` using the NextAuth v5 logic.
2. Create the Middleware to protect `/dashboard` and handle Role-Based Access (RBAC) so `LAB_ADMIN` can't access `CLIENT` routes.

**Step 3: The "Happy Path" Slice**

1. Implement the `features/orders/approve-quote` slice using the code we wrote today.
2. Set up the PayMongo Sandbox credentials in `.env`.
3. Implement the `features/payment/webhooks` route so your local environment can receive test payments (use **ngrok** to tunnel PayMongo webhooks to your local machine).

---

### 4. Why this works for your partnership with Elena

* **Cleanliness:** If Elena asks "Can we change how we calculate the platform fee?", you know exactly one file to open: `features/payment/webhooks/handlers.ts`. You don't have to hunt through the UI.
* **Speed:** Because you aren't building a mobile API or complex Redux stores, you can build features as fast as you can write Prisma queries.
* **Scaling:** If you eventually hire another developer, you can say "You own the `services` feature folder." They won't break your `payment` logic because the boundaries are physical (folders).

**Ready to `mkdir pipetgo-v2`?** You have the full technical blueprint. Is there any specific part of the "Quotation-First" logic you want to double-check before you start the first commit?