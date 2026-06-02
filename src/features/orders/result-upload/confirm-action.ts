/**
 * Server Action: confirmResultUpload
 *
 * Step 3 of the two-step RESULT upload flow. Called by the client UI after
 * the browser PUT to R2 succeeds. Re-checks LAB_ADMIN role and lab ownership
 * via order.lab.ownerId (TOCTOU) before confirming the Attachment row.
 *
 * Idempotency: uses a CAS `attachment.updateMany` guarded by `{id, orderId}`.
 * `count === 0` means the attachment is missing or belongs to a different order
 * (early-return with error). Attachment has no status column, so the empty-data
 * update is purely an existence and ownership check; a duplicate confirm is a
 * no-op because the row already passes the guard. (ref: DL-002)
 */
'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'

type ActionState = { message?: string } | null

export async function confirmResultUpload(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const attachmentIdValue = formData.get('attachmentId')
  const orderIdValue      = formData.get('orderId')

  const attachmentId = typeof attachmentIdValue === 'string' ? attachmentIdValue : null
  const orderId      = typeof orderIdValue      === 'string' ? orderIdValue      : null

  if (!attachmentId || !orderId) return { message: 'Missing field.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    return { message: 'Unauthorized.' }
  }

  const order = await prisma.order.findUnique({
    where:  { id: orderId },
    select: { lab: { select: { ownerId: true } } },
  })
  if (!order) return { message: 'Order not found.' }
  if (!order.lab) {
    throw new Error(`Order ${orderId} missing lab after explicit include — referential integrity violation`)
  }
  if (order.lab.ownerId !== session.user.id) {
    return { message: 'Order not found.' }
  }

  let updateCount = 0
  await prisma.$transaction(async (tx) => {
    const result = await tx.attachment.updateMany({
      where: { id: attachmentId, orderId },
      data:  {},
    })
    updateCount = result.count
  })

  if (updateCount === 0) {
    return { message: 'Attachment not found.' }
  }

  revalidatePath(`/dashboard/lab/orders/${orderId}`)
  return null
}
