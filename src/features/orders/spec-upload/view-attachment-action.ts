/**
 * Server Action: viewOrderAttachment
 *
 * Mints a 300s presigned R2 GET URL for a single Attachment belonging to the
 * calling CLIENT's order. The guard is ownership-by-order (order.clientId === userId),
 * not ownership-by-type — a CLIENT who owns the order is authorized to read every
 * attachment on that order, including RESULT PDFs uploaded by the lab. (ref: DL-011)
 *
 * Security: UI hiding is not a control. This action re-verifies ownership on every
 * invocation. The presigned URL is returned to the client and not stored server-side.
 * A missing order relation after explicit select is a referential-integrity violation
 * and throws rather than returning notFound(). (ref: DL-009)
 */
'use server'

import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { generatePresignedGetUrl } from '@/lib/storage/r2'

type ViewResult = { message: string } | { url: string }

export async function viewOrderAttachment(attachmentId: string): Promise<ViewResult> {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    return { message: 'Unauthorized.' }
  }

  let attachment: { r2Key: string; order: { clientId: string } | null } | null
  try {
    attachment = await prisma.attachment.findUnique({
      where:  { id: attachmentId },
      select: { r2Key: true, order: { select: { clientId: true } } },
    })
  } catch {
    return { message: 'Unable to retrieve attachment.' }
  }

  if (!attachment) {
    return { message: 'Attachment not found.' }
  }

  if (!attachment.order) {
    throw new Error(
      `Attachment ${attachmentId} missing order after explicit include — referential integrity violation`,
    )
  }

  if (attachment.order.clientId !== session.user.id) {
    return { message: 'Attachment not found.' }
  }

  let url: string
  try {
    url = await generatePresignedGetUrl(attachment.r2Key, { allowedPrefix: 'orders/' })
  } catch {
    return { message: 'Unable to retrieve attachment.' }
  }

  return { url }
}
