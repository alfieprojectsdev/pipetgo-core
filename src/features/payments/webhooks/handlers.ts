/**
 * Payment capture processor for Xendit invoice webhooks.
 *
 * processPaymentCapture runs all DB writes inside a single Prisma $transaction:
 * idempotency check, Transaction update, Order status transition, and LabWallet credit are atomic.
 * Any throw at any step rolls back all writes; Xendit retries on 500 reattempt the full capture.
 * (ref: DL-001, DL-004, DL-006)
 */
import { TransactionStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { PaymentCapturedEvent } from '@/domain/payments/events'
import { handlePaymentCaptured } from '@/features/orders/handle-payment-captured/handler'
import type { XenditInvoicePayload } from './types'

/**
 * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, dispatches
 * PaymentCapturedEvent to the orders slice handler, and credits the lab's
 * LabWallet.pendingBalance by Transaction.amount — all within one $transaction.
 * Credits LabWallet.pendingBalance atomically after Order status transition. (ref: DL-002, DL-005)
 *
 * Returns early (200 to caller) if Transaction is not found (orphan tolerance) or
 * already CAPTURED (idempotency). Both guards are inside the transaction boundary
 * to prevent race conditions from concurrent webhook deliveries; retried Xendit requests
 * exit before the LabWallet upsert, preventing double-credit. (ref: DL-004, DL-007)
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

    // Fetch Order for labId — Order.labId is non-nullable; same-tx fetch is read-consistent. (ref: DL-004)
    // Order is fetched twice per transaction (once in handlePaymentCaptured, once here) — accepted at MVP scale.
    const order = await tx.order.findUnique({
      where: { id: transaction.orderId },
      select: { labId: true },
    })

    if (!order) {
      throw new Error(`Order not found for orderId ${transaction.orderId} during LabWallet credit`)
    }

    // Credit LabWallet.pendingBalance — upsert creates on first payment, increments on subsequent.
    // Uses Transaction.amount (Decimal) not payload float. (ref: DL-002, DL-003, DL-005)
    // labId @unique (schema:299) + $transaction row lock makes this race-free under concurrent delivery.
    await tx.labWallet.upsert({
      where: { labId: order.labId },
      update: { pendingBalance: { increment: transaction.amount } },
      create: { labId: order.labId, pendingBalance: transaction.amount },
    })
  })
}
