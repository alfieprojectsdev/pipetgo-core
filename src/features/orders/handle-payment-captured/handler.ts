/**
 * Orders slice handler for PaymentCapturedEvent.
 *
 * Called inside the payments webhook $transaction — receives the shared Prisma
 * transaction client so Order.update is atomic with Transaction.update. (ref: DL-001)
 *
 * Throws on data integrity violations (order not found, invalid transition) to
 * roll back the $transaction and return 500, triggering Xendit retry. (ref: DL-010)
 */
import { OrderStatus, Prisma } from '@prisma/client'
import { PaymentCapturedEvent } from '@/domain/payments/events'
import { isValidStatusTransition } from '@/domain/orders/state-machine'

type PrismaTransactionClient = Omit<
  Prisma.TransactionClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

/**
 * Advances Order.status from PAYMENT_PENDING to ACKNOWLEDGED within the caller's
 * Prisma transaction. Sets Order.paidAt and Order.paymentMethod from the event.
 *
 * Throws if Order is not found — this is a data integrity violation, not a
 * recoverable case; the throw rolls back $transaction and yields 500 for retry. (ref: DL-010)
 *
 * Throws if isValidStatusTransition rejects the transition — defensive guard;
 * expected path is PAYMENT_PENDING → ACKNOWLEDGED. (ref: DL-001)
 */
export async function handlePaymentCaptured(
  event: PaymentCapturedEvent,
  tx: PrismaTransactionClient,
): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: event.orderId } })

  if (!order) {
    // Throw (not return) — causes $transaction rollback and 500 for Xendit retry. (ref: DL-010)
    throw new Error(`Order not found for payment capture: orderId=${event.orderId}`)
  }

  // isValidStatusTransition enforces state machine rules before any DB write. (ref: DL-001)
  if (!isValidStatusTransition(order.status, OrderStatus.ACKNOWLEDGED)) {
    throw new Error(`Invalid status transition: ${order.status} -> ACKNOWLEDGED`)
  }

  await tx.order.update({
    where: { id: event.orderId },
    // paymentMethod from event, not from a separate Transaction query — keeps handler
    // decoupled from payments slice model. (ref: DL-008, DL-009)
    data: { status: OrderStatus.ACKNOWLEDGED, paidAt: event.capturedAt, paymentMethod: event.paymentMethod ?? null },
  })
}
