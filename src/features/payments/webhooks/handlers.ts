/**
 * Payment capture processor for Xendit invoice webhooks.
 *
 * processPaymentCapture runs all DB writes inside a single Prisma $transaction:
 * idempotency check, Transaction update, and Order update are atomic.
 * Errors propagate as 500 so Xendit retries on transient DB failures. (ref: DL-004, DL-006)
 */
import { TransactionStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { PaymentCapturedEvent } from '@/domain/payments/events'
import { handlePaymentCaptured } from '@/features/orders/handle-payment-captured/handler'

interface XenditInvoicePayload {
  id: string
  status: string
  paid_amount: number
  payer_email: string
  payment_method?: string
}

/**
 * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, and dispatches
 * PaymentCapturedEvent to the orders slice handler — all within one $transaction.
 *
 * Returns early (200 to caller) if Transaction is not found (orphan tolerance) or
 * already CAPTURED (idempotency). Both guards are inside the transaction boundary
 * to prevent race conditions from concurrent webhook deliveries. (ref: DL-004)
 */
export async function processPaymentCapture(payload: XenditInvoicePayload): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Lookup by externalId (Xendit invoice ID), not Transaction.id (our cuid). (ref: DL-004)
    const transaction = await tx.transaction.findFirst({
      where: { externalId: payload.id },
    })

    if (!transaction) {
      // Orphan tolerance — Xendit may deliver for invoices not in our DB.
      return
    }

    if (transaction.status === TransactionStatus.CAPTURED) {
      // Idempotency guard — inside $transaction to close concurrent-delivery race. (ref: DL-004)
      return
    }

    const capturedAt = new Date()

    await tx.transaction.update({
      where: { id: transaction.id },
      data: {
        status: TransactionStatus.CAPTURED,
        capturedAt,
        paymentMethod: payload.payment_method ?? null,
      },
    })

    // amount from Transaction.amount (Decimal), not payload.paid_amount (float) —
    // avoids floating-point drift; amount was validated at checkout creation. (ref: DL-005)
    const event: PaymentCapturedEvent = {
      orderId: transaction.orderId,
      transactionId: transaction.id,
      amount: transaction.amount,
      gatewayRef: transaction.externalId,
      capturedAt,
      paymentMethod: payload.payment_method,
    }

    // Delegates Order.status transition to orders slice — ADR-001 fan-out pattern. (ref: DL-001)
    await handlePaymentCaptured(event, tx)
  })
}
