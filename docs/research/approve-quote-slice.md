> **STALE — pre-V2 foundation draft.** Do not implement directly.
> Conflicts with V2 foundation: references `quoteApprovedAt`/`quoteRejectedAt` fields
> absent from the schema; bypasses `isValidStatusTransition()`; defines client details
> schema locally instead of importing from `@/domain/orders/client-details.ts`.
> Reconcile against `prisma/schema.prisma` and `src/domain/` before using as a plan input.

## 📁 The Directory Structure

Instead of scattering logic across `src/app/api/orders/...` and `src/lib/validations/...`, everything related to approving a quote lives right next to the UI that triggers it:

```text
src/features/orders/approve-quote/
├── schema.ts      # The single source of truth for validation
├── action.ts      # The Next.js Server Action (Mutation & DB logic)
└── ui.tsx         # The React Client Component (Buttons & State)

```

### 1. The Validation (`schema.ts`)

This solves the V1 debt of having duplicate, inline Zod schemas. Both the Client Component (for instant feedback) and the Server Action (for strict security) use this exact same schema.

```typescript
import { z } from 'zod';

export const approveQuoteSchema = z.object({
  orderId: z.string().cuid(),
  approved: z.boolean(),
  rejectionReason: z.string().min(10).max(500).optional()
}).refine(data => {
  // If they reject, they MUST provide a reason.
  if (!data.approved && !data.rejectionReason) return false;
  return true;
}, {
  message: "Rejection reason is required when declining a quote.",
  path: ["rejectionReason"]
});

export type ApproveQuoteInput = z.infer<typeof approveQuoteSchema>;

```

### 2. The Server Action (`action.ts`)

This file replaces the complex V1 API route handler. It runs entirely on the server. Notice how it integrates the **V2 Payment Transition** directly into the atomic Prisma query.

```typescript
'use server'

import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { approveQuoteSchema, type ApproveQuoteInput } from './schema';
import { revalidatePath } from 'next/cache';

export async function approveQuoteAction(input: ApproveQuoteInput) {
  try {
    // 1. Auth & Role Guard
    const session = await getServerSession(authOptions);
    if (!session?.user || session.user.role !== 'CLIENT') {
      return { error: 'Unauthorized. Only clients can approve quotes.' };
    }

    // 2. Strict Payload Validation
    const parsed = approveQuoteSchema.safeParse(input);
    if (!parsed.success) {
      return { error: 'Validation failed.', details: parsed.error.flatten() };
    }

    const { orderId, approved, rejectionReason } = parsed.data;
    
    // V2 Logic: Approving moves it directly to the new payment gateway state
    const newStatus = approved ? 'PAYMENT_PENDING' : 'QUOTE_REJECTED'; 

    // 3. Atomic State Transition
    // updateMany guarantees it only updates if currently in QUOTE_PROVIDED 
    // AND explicitly belongs to this client.
    const result = await prisma.order.updateMany({
      where: {
        id: orderId,
        clientId: session.user.id,
        status: 'QUOTE_PROVIDED'
      },
      data: {
        status: newStatus,
        ...(approved 
          ? { quoteApprovedAt: new Date() } 
          : { quoteRejectedAt: new Date(), quoteRejectedReason: rejectionReason }
        )
      }
    });

    if (result.count === 0) {
      return { error: 'Order not found, not yours, or quote is no longer pending.' };
    }

    // 4. Cache Revalidation 
    revalidatePath(`/dashboard/client/orders/${orderId}`);
    revalidatePath('/dashboard/client');

    return { success: true, newStatus };

  } catch (error) {
    console.error('[approveQuoteAction]', error);
    return { error: 'An unexpected system error occurred.' };
  }
}

```

### 3. The React Client Component (`ui.tsx`)

This component imports the Server Action like a regular JavaScript function. It uses React's `useTransition` to handle loading states smoothly without heavy global state managers.

```tsx
'use client'

import { useState, useTransition } from 'react';
import { approveQuoteAction } from './action';
// Assuming 'sonner' for toast notifications based on V1 styling
import { toast } from 'sonner'; 

interface Props {
  orderId: string;
}

export function QuoteApprovalControls({ orderId }: Props) {
  const [isPending, startTransition] = useTransition();
  const [rejectionReason, setRejectionReason] = useState('');

  const handleAction = (approved: boolean) => {
    if (!approved && rejectionReason.length < 10) {
      toast.error("Please provide a valid reason for rejection.");
      return;
    }

    startTransition(async () => {
      const result = await approveQuoteAction({
        orderId,
        approved,
        rejectionReason: approved ? undefined : rejectionReason
      });

      if (result?.error) {
        toast.error(result.error);
        return;
      }

      toast.success(approved ? 'Quote approved!' : 'Quote rejected.');
      
      // V2 Next Step Integration: 
      // If approved, trigger a redirect to the Xendit/PayMongo checkout URL here.
    });
  };

  return (
    <div className="flex flex-col gap-4 p-4 border rounded-md bg-zinc-50">
      <p className="text-sm font-medium">Please review the quoted price above.</p>
      
      {!isPending && (
        <textarea 
          placeholder="Reason for rejection (if applicable)"
          className="w-full p-2 text-sm border rounded"
          onChange={(e) => setRejectionReason(e.target.value)}
        />
      )}

      <div className="flex gap-2">
        <button 
          onClick={() => handleAction(false)}
          disabled={isPending}
          className="px-4 py-2 text-red-600 border border-red-600 rounded hover:bg-red-50 disabled:opacity-50"
        >
          {isPending ? 'Processing...' : 'Reject Quote'}
        </button>

        <button 
          onClick={() => handleAction(true)}
          disabled={isPending}
          className="px-4 py-2 text-white bg-green-600 rounded hover:bg-green-700 disabled:opacity-50"
        >
          {isPending ? 'Processing...' : 'Approve & Proceed to Payment'}
        </button>
      </div>
    </div>
  );
}

```