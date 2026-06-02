/**
 * Server Action: confirmSpecUpload
 *
 * Step 3 of the two-step SPECIFICATION upload flow. Called by the client UI
 * after the browser PUT to R2 succeeds. Re-checks CLIENT role and order ownership
 * (TOCTOU). Uses a CAS updateMany {id, orderId} pattern — count===0 means the
 * attachment was not found or belongs to a different order. r2Key @unique on the
 * Attachment model provides idempotency if the client retries confirm. (ref: DL-002)
 */
'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'

type ActionState = { message?: string } | null

export async function confirmSpecUpload(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const attachmentIdValue = formData.get('attachmentId')
  const orderIdValue      = formData.get('orderId')

  const attachmentId = typeof attachmentIdValue === 'string' ? attachmentIdValue : null
  const orderId      = typeof orderIdValue      === 'string' ? orderIdValue      : null

  if (!attachmentId || !orderId) return { message: 'Missing field.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    return { message: 'Unauthorized.' }
  }

  const order = await prisma.order.findUnique({
    where:  { id: orderId },
    select: { clientId: true },
  })
  if (!order || order.clientId !== session.user.id) {
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

  revalidatePath(`/dashboard/orders/${orderId}`)
  return null
}
