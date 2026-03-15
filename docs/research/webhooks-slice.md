> **STALE — pre-V2 foundation draft.** Do not implement directly.
> Conflicts with V2 foundation: `handlers.ts` transitions order to `'PENDING'` after
> payment capture (the dual-semantics bug fixed in V2 — correct target is `ACKNOWLEDGED`
> via `isValidStatusTransition()`); `events.ts` is a raw PayMongo payload type, not the
> domain event interfaces in `src/domain/payments/events.ts`.
> Reconcile against ADR-001 and `src/domain/` before using as a plan input.

## 🪝 The Webhook Slice (`features/payment/webhooks`)

Now that we are fully committed to Server Actions for the frontend, the only traditional API routes (`route.ts`) you actually need to build are for external systems like PayMongo or Xendit communicating back to your server.

In a Vertical Slice Architecture, you isolate this completely from your `orders` slice. The payment slice handles the cryptography and transaction logging, and then updates the order status atomically.

Here is the directory structure for this slice:

```text
src/features/payment/webhooks/
├── events.ts        # TypeScript interfaces for the aggregator payloads
├── handlers.ts      # The Prisma logic (Idempotency and DB updates)
└── route.ts         # The Next.js API endpoint (Signature verification)

```

### 1. The API Route (`route.ts`)

This is the front door. Its only jobs are to ensure the request is actually from the payment aggregator (via cryptographic signature) and to route it to the right handler.

```typescript
// src/features/payment/webhooks/route.ts
import { crypto } from 'crypto';
import { handlePaymentSuccess } from './handlers';

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    // Example using PayMongo's signature header
    const signature = req.headers.get('paymongo-signature'); 

    // 1. Verify Signature (Security Boundary)
    const expectedSignature = crypto
      .createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET!)
      .update(rawBody)
      .digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature ?? ''),
      Buffer.from(expectedSignature)
    );

    if (!isValid) {
      return Response.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // 2. Parse and Route
    const event = JSON.parse(rawBody);

    switch (event.data.attributes.type) {
      case 'payment.paid':
        await handlePaymentSuccess(event);
        break;
      // Add other cases like 'payment.failed' or 'refund.updated' later
      default:
        console.log(`Unhandled event type: ${event.data.attributes.type}`);
    }

    // Always return 200 quickly so the aggregator doesn't retry
    return Response.json({ received: true }, { status: 200 });

  } catch (error) {
    console.error('[Webhook Error]', error);
    return Response.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

```

### 2. The Database Logic (`handlers.ts`)

This is where the magic happens. Webhooks can sometimes be delivered twice by the aggregator due to network hiccups. This handler uses a strict Prisma `updateMany` to guarantee **idempotency**—meaning if the webhook fires twice, the database is only updated once.

```typescript
// src/features/payment/webhooks/handlers.ts
import { prisma } from '@/lib/db';
import type { PayMongoWebhookEvent } from './events';

export async function handlePaymentSuccess(event: PayMongoWebhookEvent) {
  const paymentIntentId = event.data.attributes.payment_intent_id;

  // 1. Start a database transaction to ensure both records update together
  await prisma.$transaction(async (tx) => {
    
    // 2. Idempotent check: Update the transaction ONLY if it is currently PENDING
    const transactionUpdate = await tx.transaction.updateMany({
      where: {
        externalId: paymentIntentId,
        status: 'PENDING', 
      },
      data: {
        status: 'CAPTURED',
        capturedAt: new Date(),
        metadata: event.data.attributes,
      },
    });

    // If count is 0, we already processed this webhook. Exit safely.
    if (transactionUpdate.count === 0) {
      console.log(`[Webhook] Transaction ${paymentIntentId} already captured. Skipping.`);
      return;
    }

    // 3. Find the associated Order ID
    const txRecord = await tx.transaction.findUnique({
      where: { externalId: paymentIntentId },
      select: { orderId: true }
    });

    if (!txRecord) throw new Error('Orphaned transaction found');

    // 4. Advance the Order state machine!
    await tx.order.update({
      where: { id: txRecord.orderId },
      data: {
        status: 'PENDING', // The lab can now see it and acknowledge it
        paidAt: new Date(),
        // Denormalize the payment method for easy UI display
        paymentMethod: event.data.attributes.source?.type ?? 'unknown', 
      },
    });
    
    // In the future (Option A), you would queue the lab's Payout calculation here.
  });
}

```

### 3. The Payload Types (`events.ts`)

A simple TypeScript file to keep your handler type-safe based on the aggregator's documentation.

```typescript
// src/features/payment/webhooks/events.ts
export interface PayMongoWebhookEvent {
  data: {
    id: string;
    type: string;
    attributes: {
      type: string;
      livemode: boolean;
      payment_intent_id: string;
      amount: number;
      source?: {
        type: string;
      };
      // ... other fields based on the API docs
    };
  };
}

```