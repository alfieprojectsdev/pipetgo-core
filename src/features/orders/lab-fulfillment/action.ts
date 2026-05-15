'use server'

/**
 * Server actions for the lab fulfillment flow.
 *
 * startProcessing: ACKNOWLEDGED -> IN_PROGRESS
 * completeOrder:   IN_PROGRESS  -> COMPLETED
 *
 * Both actions:
 *   1. Validate formData (orderId present).
 *   2. Auth guard — LAB_ADMIN session required (TOCTOU re-check).
 *   3. Atomically re-fetch Order, verify ownership + status, and write new status
 *      inside a $transaction to eliminate the TOCTOU race window.
 *   4. Call isValidStatusTransition() before any Prisma write.
 *   5. Write new status to DB.
 *   6. revalidatePath so the page reflects the updated state.
 */

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { OrderStatus, TransactionStatus, PayoutStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { isValidStatusTransition } from '@/domain/orders/state-machine'
import { COMMISSION_RATE } from '@/domain/payments/commission'

type ActionState = { message?: string } | null

/**
 * Transitions an ACKNOWLEDGED order to IN_PROGRESS. The re-fetch, ownership
 * check, and status write are wrapped in a single $transaction for an atomic
 * read-check-write, eliminating the TOCTOU race window. (ref: DL-007)
 * Ownership is re-verified against Lab.ownerId — formData orderId alone is
 * untrusted. Page re-renders via revalidatePath; no redirect. (ref: DL-006)
 */
export async function startProcessing(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orderId = formData.get('orderId') as string | null
  if (!orderId) return { message: 'Missing order ID.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    return { message: 'Unauthorized.' }
  }

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { lab: true },
    })

    if (!order || !order.lab || order.lab.ownerId !== session.user.id) {
      return { message: 'Order not found.' }
    }
    if (!isValidStatusTransition(order.status, OrderStatus.IN_PROGRESS)) {
      return { message: 'Order cannot be transitioned to IN_PROGRESS from current status.' }
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.IN_PROGRESS },
    })

    return null
  })

  if (result !== null) return result

  revalidatePath(`/dashboard/lab/orders/${orderId}`)
  return null
}

/**
 * Transitions an IN_PROGRESS order to COMPLETED and writes the lab
 * technician's result notes to Order.notes. The re-fetch, ownership check,
 * status write, and Payout creation are wrapped in a single $transaction for
 * an atomic read-check-write, eliminating the TOCTOU race window. (ref: DL-003, DL-015)
 * Creates a QUEUED Payout recording commission confirmed at order completion.
 * Redirects to /dashboard/lab on success. (ref: DL-006, DL-007)
 */
export async function completeOrder(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orderId = formData.get('orderId') as string | null
  if (!orderId) return { message: 'Missing order ID.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    return { message: 'Unauthorized.' }
  }

  const notes = (formData.get('notes') as string | null)?.trim() || null

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { lab: true },
    })

    if (!order || !order.lab || order.lab.ownerId !== session.user.id) {
      return { message: 'Order not found.' }
    }
    if (!isValidStatusTransition(order.status, OrderStatus.COMPLETED)) {
      return { message: 'Order cannot be transitioned to COMPLETED from current status.' }
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.COMPLETED,
        ...(notes != null ? { notes } : {}),
      },
    })

    // Order.update precedes the Payout write: the TOCTOU guard above has already
    // validated IN_PROGRESS -> COMPLETED; status write first preserves the
    // established action.ts pattern (status write, then ledger writes). (ref: DL-011)

    // findFirst because Transaction has no @unique on (orderId, status) — it is
    // an @@index only. At COMPLETED time exactly one CAPTURED row exists per orderId
    // (capture is idempotent; retries write new PENDING rows, not new CAPTURED). (ref: DL-004)
    const capturedTransaction = await tx.transaction.findFirst({
      where: { orderId, status: TransactionStatus.CAPTURED },
    })

    if (!capturedTransaction) {
      // Absence is a contract violation per Implementation Discipline — throw, never default. (ref: DL-004)
      throw new Error(`No CAPTURED Transaction found for orderId ${orderId} during Payout creation`)
    }

    // All arithmetic on Prisma Decimal instances — no Number coercion at any step.
    // capturedTransaction.amount is Decimal(12,2) per schema.prisma:247. (ref: DL-006, DL-013)
    const grossAmount = capturedTransaction.amount
    const platformFee = grossAmount.mul(COMMISSION_RATE)
    const netAmount = grossAmount.sub(platformFee)

    await tx.payout.create({
      data: {
        orderId,
        labId: order.lab.id, // relation object already in memory from ownership check (ref: DL-012)
        transactionId: capturedTransaction.id,
        grossAmount,
        platformFee,
        netAmount,
        feePercentage: COMMISSION_RATE,
        status: PayoutStatus.QUEUED, // T-10 (settlement webhook) owns QUEUED -> COMPLETED. (ref: DL-007)
      },
    })

    return null
  })

  if (result !== null) return result

  revalidatePath('/dashboard/lab')
  redirect('/dashboard/lab')
}
