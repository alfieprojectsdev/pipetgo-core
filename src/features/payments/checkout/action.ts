'use server'

/**
 * Server action for the deferred-payment checkout flow.
 *
 * Sequence:
 *   1. Validate formData (orderId present).
 *   2. Auth guard — CLIENT session required (TOCTOU re-check; page already gated).
 *   3. Re-fetch Order from DB and verify clientId + status === PAYMENT_PENDING
 *      (TOCTOU guard: order status may change between page load and action execution).
 *   4. Idempotency guard — if a PENDING Transaction already exists for the order,
 *      redirect to its checkoutUrl immediately; skip Xendit call (ref: DL-004).
 *   5. Generate a cuid. This becomes Transaction.id AND the Xendit external_id
 *      parameter. Xendit's returned invoice ID is stored in Transaction.externalId
 *      (DB column). Two distinct IDs in play — see DL-003.
 *   6. Call createXenditInvoice BEFORE writing to DB (ref: DL-002).
 *   7. Prisma Transaction.create — provider='xendit' (String, not enum) (ref: DL-001).
 *   8. redirect(checkoutUrl) as the LAST statement in the success path.
 *
 * Invariants:
 *   - redirect() is never inside try/catch — Next.js throws NEXT_REDIRECT
 *     internally; catching it swallows the redirect.
 *   - Order.status is NOT mutated here. The webhook handler advances status
 *     after Xendit confirms payment (ref: DL-007).
 *   - isValidStatusTransition() is NOT called — no status mutation occurs (ref: DL-007).
 */

import { redirect } from 'next/navigation'
import { Prisma, OrderStatus, TransactionStatus } from '@prisma/client'
import { createId } from '@paralleldrive/cuid2'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { createXenditInvoice, XenditApiError } from '@/lib/payments/xendit'

type ActionState = { message?: string } | null

/** useActionState-compatible signature. Wraps the full checkout flow. */
export async function initiateCheckout(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orderId = formData.get('orderId') as string | null
  if (!orderId) return { message: 'Missing order ID.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    return { message: 'Unauthorized.' }
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { clientProfile: true, service: true },
  })

  if (!order || order.clientId !== session.user.id) {
    return { message: 'Order not found.' }
  }
  if (order.status !== OrderStatus.PAYMENT_PENDING) {
    return { message: 'Order is not awaiting payment.' }
  }
  if (!order.clientProfile) {
    return { message: 'Order profile is incomplete.' }
  }
  if (!order.quotedPrice) {
    return { message: 'Order does not have a quoted price.' }
  }

  // Idempotency guard: double-submit or browser back+resubmit must not create a
  // second Xendit invoice. If a PENDING Transaction exists, redirect immediately
  // without calling Xendit again. (ref: DL-004)
  const existing = await prisma.transaction.findFirst({
    where: { orderId, status: TransactionStatus.PENDING },
  })
  if (existing?.checkoutUrl) {
    redirect(existing.checkoutUrl)
  }

  // Transaction.id doubles as the Xendit external_id parameter for correlation.
  // Transaction.externalId (DB column) stores the Xendit invoice ID from the response.
  // Two distinct IDs support PAYMENT_FAILED retry flows where multiple Transactions
  // exist per orderId. (ref: DL-003)
  const transactionId = createId()

  let checkoutUrl: string
  try {
    // Xendit call precedes DB write (ref: DL-002): orphaned Xendit invoices are
    // recoverable via idempotency on retry; missing local records are not.
    const result = await createXenditInvoice({
      externalId: transactionId,
      amount: order.quotedPrice.toNumber(),
      payerEmail: order.clientProfile.email,
      description: `PipetGo Lab Test: ${order.service.name}`,
      successRedirectUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/dashboard/orders/${orderId}`,
    })

    await prisma.transaction.create({
      data: {
        id: transactionId,
        orderId,
        externalId: result.invoiceId,
        provider: 'xendit',
        amount: order.quotedPrice,
        currency: 'PHP',
        status: TransactionStatus.PENDING,
        checkoutUrl: result.invoiceUrl,
        metadata: result.rawResponse as Prisma.InputJsonValue,
      },
    })

    checkoutUrl = result.invoiceUrl
  } catch (err) {
    if (err instanceof XenditApiError) {
      return { message: 'Payment service error. Please try again.' }
    }
    return { message: 'Unable to reach payment service. Please try again later.' }
  }

  redirect(checkoutUrl)
}
