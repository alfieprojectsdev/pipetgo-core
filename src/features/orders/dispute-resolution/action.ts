'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { OrderStatus, DisputeResolution } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { isValidStatusTransition } from '@/domain/orders/state-machine'

type ActionState = { message?: string } | null

/**
 * Resolves a DISPUTED order in either direction.
 *
 * Authorization: ADMIN role re-checked here independently of the layout guard.
 * The layout guard is layer-1 only; Server Actions are POST-invocable without
 * navigating through the layout (TOCTOU, DL-006).
 *
 * Resolution: RESOLVED_COMPLETED -> DISPUTED->COMPLETED (payout hold lifted).
 *             RESOLVED_REFUND    -> DISPUTED->REFUND_PENDING (refund manual).
 *
 * CAS: updateMany on Order.status===DISPUTED so two admins resolving concurrently
 * results in the second write observing count===0 without clobbering the first.
 * OrderDispute.resolvedAt is also written atomically inside the same $transaction.
 */
export async function resolveDispute(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orderIdValue = formData.get('orderId')
  const resolutionValue = formData.get('resolution')
  const resolutionNoteValue = formData.get('resolutionNote')

  // typeof guards enforce runtime narrowing of FormDataEntryValue | null
  // before any string operations — 'as string' is forbidden (CLAUDE.md discipline).
  const orderId = typeof orderIdValue === 'string' ? orderIdValue : null
  const resolution = typeof resolutionValue === 'string' ? resolutionValue : null
  const resolutionNoteRaw = typeof resolutionNoteValue === 'string' ? resolutionNoteValue.trim() : ''
  const resolutionNote = resolutionNoteRaw !== '' ? resolutionNoteRaw : null

  if (!orderId) return { message: 'Missing order ID.' }
  if (
    resolution !== DisputeResolution.RESOLVED_COMPLETED &&
    resolution !== DisputeResolution.RESOLVED_REFUND
  ) {
    return { message: 'Invalid resolution value.' }
  }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
    return { message: 'Unauthorized.' }
  }

  const targetStatus =
    resolution === DisputeResolution.RESOLVED_COMPLETED
      ? OrderStatus.COMPLETED
      : OrderStatus.REFUND_PENDING

  if (!isValidStatusTransition(OrderStatus.DISPUTED, targetStatus)) {
    throw new Error(`resolveDispute: unexpected targetStatus ${targetStatus} — state-machine contract violated`)
  }

  let result: ActionState = null
  let shouldRedirect = false

  try {
    await prisma.$transaction(async (tx) => {
      // CAS write: where predicate locks on status===DISPUTED so a second
      // concurrent resolution sees count===0 and returns without clobbering (ref: DL-005).
      const updateResult = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.DISPUTED },
        data: { status: targetStatus },
      })

      if (updateResult.count === 0) {
        result = { message: 'Order is no longer in DISPUTED status — resolution may have already been recorded.' }
        return
      }

      await tx.orderDispute.update({
        where: { orderId },
        data: {
          resolution,
          resolvedAt: new Date(),
          resolvedById: session.user.id,
          resolutionNote,
        },
      })

      shouldRedirect = true
    })
  } catch (e) {
    throw new Error(`resolveDispute transaction failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (result !== null) return result

  revalidatePath('/dashboard/admin/disputes')

  if (shouldRedirect) {
    redirect('/dashboard/admin/disputes')
  }

  return null
}
