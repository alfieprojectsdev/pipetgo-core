/**
 * Payment capture and failure processors for Xendit invoice webhooks.
 *
 * processPaymentCapture and processPaymentFailed run all DB writes inside a single Prisma $transaction.
 * Any throw at any step rolls back all writes; Xendit retries on 500 reattempt the full capture.
 * (ref: DL-001, DL-004, DL-006)
 */
import { OrderStatus, TransactionStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { PaymentCapturedEvent } from '@/domain/payments/events'
import { handlePaymentCaptured } from '@/features/orders/handle-payment-captured/handler'
import { isValidStatusTransition } from '@/domain/orders/state-machine'
import type { XenditInvoicePayload } from './types'

/**
 * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, and dispatches
 * PaymentCapturedEvent to the orders slice handler — all within one $transaction.
 * No LabWallet write; commission is tracked via Payout records created inside
 * completeOrder at order completion. (ref: DL-001, DL-016)
 *
 * Returns early (200 to caller) if Transaction is not found (orphan tolerance) or
 * already CAPTURED (idempotency). Both guards are inside the transaction boundary
 * to prevent race conditions from concurrent Xendit deliveries. (ref: DL-004, DL-007)
 */
export async function processPaymentCapture(payload: XenditInvoicePayload): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Lookup by externalId (Xendit invoice ID), not Transaction.id (our cuid). (ref: DL-004)
    // findUnique enforces the @unique constraint at query level (Implementation Discipline).
    const transaction = await tx.transaction.findUnique({
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

    if (transaction.status === TransactionStatus.FAILED) {
      // EXPIRED-then-PAID concurrent delivery: refuse to overwrite terminal FAILED with CAPTURED. (ref: R-007)
      console.info(`[processPaymentCapture] received PAID for FAILED transaction id=${payload.id}`)
      throw new Error(`Refusing to capture FAILED transaction ${transaction.id}: EXPIRED already terminal`)
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

/**
 * Marks Transaction FAILED and transitions Order PAYMENT_PENDING→PAYMENT_FAILED.
 * Mirrors processPaymentCapture: same $transaction boundary, orphan tolerance,
 * idempotency-by-terminal-status. (ref: DL-001)
 * No LabWallet write — failed payments produce no lab credit. (ref: DL-007)
 */
export async function processPaymentFailed(payload: XenditInvoicePayload): Promise<void> {
  console.info(`[processPaymentFailed] enter id=${payload.id} status=${payload.status}`)

  await prisma.$transaction(async (tx) => {
    // findUnique enforces the @unique constraint at query level (Implementation Discipline).
    const transaction = await tx.transaction.findUnique({
      where: { externalId: payload.id },
    })

    if (!transaction) {
      console.info(`[processPaymentFailed] orphan tolerance id=${payload.id}`)
      return
    }

    if (transaction.status === TransactionStatus.FAILED) {
      // Idempotency guard — inside $transaction to close concurrent-delivery race. (ref: DL-004)
      console.info(`[processPaymentFailed] idempotent no-op id=${payload.id}`)
      return
    }

    if (transaction.status === TransactionStatus.CAPTURED) {
      // PAID-then-EXPIRED concurrent delivery: refuse to mark a CAPTURED transaction as FAILED.
      // Symmetric guard to processPaymentCapture R-007. The state machine would throw below
      // (ACKNOWLEDGED→PAYMENT_FAILED is invalid), but this guard makes the intent explicit
      // so a future developer does not interpret the asymmetry as an oversight.
      console.info(`[processPaymentFailed] received EXPIRED for CAPTURED transaction id=${payload.id}`)
      return
    }

    await tx.transaction.update({
      where: { id: transaction.id },
      data: {
        status: TransactionStatus.FAILED,
        failureReason: `Xendit invoice ${payload.status}`,
      },
    })

    const order = await tx.order.findUnique({
      where: { id: transaction.orderId },
    })

    if (!order) {
      throw new Error(`Order not found for orderId ${transaction.orderId} during EXPIRED processing`)
    }

    if (!isValidStatusTransition(order.status, OrderStatus.PAYMENT_FAILED)) {
      throw new Error(`Cannot transition Order ${order.id} from ${order.status} to PAYMENT_FAILED`)
    }

    await tx.order.update({
      where: { id: transaction.orderId },
      data: { status: OrderStatus.PAYMENT_FAILED },
    })
  })
}
