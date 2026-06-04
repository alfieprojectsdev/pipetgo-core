'use server'

import { revalidatePath } from 'next/cache'
import { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { isValidStatusTransition } from '@/domain/orders/state-machine'
import { isWithinDisputeWindow } from '@/domain/orders/dispute'

type ActionState = { message?: string } | null

/**
 * Transitions a COMPLETED order to DISPUTED and creates an OrderDispute row.
 *
 * Authorization: CLIENT role; ownership enforced inside $transaction (DL-006).
 * Window guard: order must have completedAt set and be within DISPUTE_WINDOW_DAYS.
 * State guard: isValidStatusTransition(COMPLETED, DISPUTED) via single enforcement point.
 * Dispute creation is atomic with the status write; both roll back on any throw.
 * redirect() is called after — never inside — the transaction block.
 */
export async function openDispute(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orderIdValue = formData.get('orderId')
  const reasonValue = formData.get('reason')

  // typeof guards enforce runtime narrowing of FormDataEntryValue | null
  // before any string operations — 'as string' is forbidden (CLAUDE.md discipline).
  const orderId = typeof orderIdValue === 'string' ? orderIdValue : null
  const reason = typeof reasonValue === 'string' ? reasonValue.trim() : ''

  if (!orderId) return { message: 'Missing order ID.' }
  if (!reason) return { message: 'Dispute reason is required.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    return { message: 'Unauthorized.' }
  }

  let result: ActionState = null

  try {
    result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { dispute: true },
      })

      if (!order) return { message: 'Order not found.' }
      if (order.clientId !== session.user.id) return { message: 'Order not found.' }

      // One dispute per order (OrderDispute.orderId is @unique). A resolved order
      // returns to COMPLETED and keeps its OrderDispute row, so a repeat visit would
      // otherwise hit the unique constraint on create() and throw. Guard explicitly.
      if (order.dispute) {
        return { message: 'A dispute has already been opened for this order.' }
      }

      // completedAt null means the order predates the dispute-window feature; treat as out-of-window,
      // not a crash — callers of isWithinDisputeWindow must not receive null (ref: DL-010).
      if (!order.completedAt) {
        return { message: 'Order has no completion timestamp — dispute window cannot be determined.' }
      }
      if (!isWithinDisputeWindow(order.completedAt, new Date())) {
        return { message: 'The 14-day dispute window for this order has passed.' }
      }
      if (!isValidStatusTransition(order.status, OrderStatus.DISPUTED)) {
        return { message: 'Order cannot be disputed from its current status.' }
      }

      // CAS: lock the transition on the status we validated so a concurrent write
      // (another dispute submit, an admin action) is detected via count === 0 rather
      // than silently clobbered — same webhook compare-and-set discipline as elsewhere.
      const transition = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: OrderStatus.DISPUTED },
      })

      if (transition.count === 0) {
        return { message: 'Order can no longer be disputed.' }
      }

      await tx.orderDispute.create({
        data: { orderId, reason },
      })

      return null
    })
  } catch (e) {
    throw new Error(`openDispute transaction failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (result !== null) return result

  revalidatePath(`/dashboard/orders/${orderId}`)
  return null
}
