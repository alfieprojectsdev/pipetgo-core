### 1. The PayMongo Client Wrapper

This function handles the authentication and payload construction. Notice how we explicitly enable `paymaya`, `gcash`, and `dob` (Direct Online Banking/PESONet) to cover the Philippine market requirements you discussed with Elena.

```typescript
// src/features/payment/lib/paymongo.ts

const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY;
const BASE_URL = 'https://api.paymongo.com/v1';

export async function createCheckoutSession({
  orderId,
  amountInPhp,
  clientEmail,
  clientName,
}: {
  orderId: string;
  amountInPhp: number;
  clientEmail: string;
  clientName: string;
}) {
  // PayMongo expects amounts in cents (e.g., PHP 100.00 = 10000)
  const amountInCents = Math.round(amountInPhp * 100);

  const options = {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'Content-Type': 'application/json',
      authorization: `Basic ${Buffer.from(PAYMONGO_SECRET_KEY + ':').toString('base64')}`,
    },
    body: JSON.stringify({
      data: {
        attributes: {
          send_email_receipt: true,
          show_description: true,
          show_line_items: true,
          description: `PipetGo! Order #${orderId.slice(-6)}`,
          line_items: [
            {
              amount: amountInCents,
              currency: 'PHP',
              name: 'Laboratory Testing Services',
              quantity: 1,
            },
          ],
          payment_method_types: [
            'gcash', 
            'paymaya', 
            'qrph', 
            'dob',      // Direct Online Banking (PESONet/InstaPay)
            'card',     // Credit/Debit Cards
            'billease'  // Buy Now Pay Later (optional)
          ],
          success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/orders/${orderId}?status=success`,
          cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/orders/${orderId}?status=cancelled`,
          reference_number: orderId,
        },
      },
    }),
  };

  const response = await fetch(`${BASE_URL}/checkout_sessions`, options);
  const json = await response.json();

  if (!response.ok) {
    throw new Error(json.errors?.[0]?.detail || 'Failed to create PayMongo session');
  }

  return {
    checkoutUrl: json.data.attributes.checkout_url,
    paymentIntentId: json.data.attributes.payment_intent_id,
  };
}

```

### 2. Integration into the "Approve Quote" Slice

Now, we update the `approveQuoteAction` we drafted earlier. Instead of just updating the database, it now calls the PayMongo wrapper and returns a `checkoutUrl`. The UI will then redirect the client directly to the payment page.

```typescript
// src/features/orders/approve-quote/action.ts (Updated for Payments)

import { createCheckoutSession } from '@/features/payment/lib/paymongo';

export async function approveQuoteAction(input: ApproveQuoteInput) {
  // ... (Auth and Validation logic from earlier) ...

  return await prisma.$transaction(async (tx) => {
    // 1. Advance the Order state
    const order = await tx.order.update({
      where: { id: orderId, clientId: session.user.id },
      data: { status: 'PAYMENT_PENDING' },
      include: { client: true } // Need email/name for PayMongo
    });

    // 2. Generate the real PayMongo session
    const { checkoutUrl, paymentIntentId } = await createCheckoutSession({
      orderId: order.id,
      amountInPhp: order.quotedPrice.toNumber(),
      clientEmail: order.client.email,
      clientName: order.client.name || 'PipetGo Client',
    });

    // 3. Store the Transaction record in PENDING state
    await tx.transaction.create({
      data: {
        orderId: order.id,
        externalId: paymentIntentId,
        provider: 'paymongo',
        amount: order.quotedPrice,
        status: 'PENDING',
        checkoutUrl: checkoutUrl,
      }
    });

    // 4. Return the URL so the UI can redirect
    return { success: true, checkoutUrl };
  });
}

```

### 3. The UI Hand-off

In your `ui.tsx`, when the server returns the `checkoutUrl`, you simply use `window.location.assign()` to send the user to the secure PayMongo hosted page.

```typescript
// src/features/orders/approve-quote/ui.tsx

startTransition(async () => {
  const result = await approveQuoteAction({ orderId, approved: true });

  if (result.success && result.checkoutUrl) {
    toast.success("Redirecting to secure payment...");
    window.location.assign(result.checkoutUrl); // Sends them to GCash/Card/QR Ph portal
  } else {
    toast.error(result.error);
  }
});

```
